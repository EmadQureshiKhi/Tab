/**
 * `GET /api/health` - build info, and whether the two upstreams answer.
 *
 * A thin adapter and nothing else, matching `/api/settlements`: every decision
 * lives in `serveHealth`, which is a pure function from two probes to a status,
 * headers and a body, so the interesting behaviour is tested without standing up
 * a server or an upstream.
 *
 * It answers for one network: `?network=testnet` or `?network=mainnet` when a
 * monitor names it, else the visitor's cookie, else the deployment's default.
 */

import { serveHealth } from "../../../src/dashboard/api-health";
import { toResponse } from "../../../src/dashboard/api-settlements";
import { requestContext } from "../../_lib/context";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const context = requestContext(request);
  const result = await serveHealth({
    chain: context.chain,
    registry: { probe: () => context.registry.health() },
  });
  return toResponse(result) as Response;
}
