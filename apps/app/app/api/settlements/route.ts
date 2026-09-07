/**
 * `GET /api/settlements` - the cursor-paginated feed.
 *
 * A thin adapter and nothing else. Every decision the route makes lives in
 * `serveSettlements`, which is a pure function from a query to a status, headers
 * and a body, so the interesting behaviour is tested without standing up a
 * server. This file only turns the App Router's `Request` into that query and
 * the result into a `Response`.
 *
 * Requirements: 24.4, 24.6, 24.9
 */

import { serveSettlements, toResponse } from "../../../src/dashboard/api-settlements";
import { registry } from "../../_lib/context";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const result = await serveSettlements({ registry: registry() }, url.searchParams);
  return toResponse(result) as Response;
}
