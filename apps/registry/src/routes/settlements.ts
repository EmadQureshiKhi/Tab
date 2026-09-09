/**
 * Settlement and delivery reads.
 *
 * ## The identity is the settlement id
 *
 * `/settlements/:settlementId` and nothing else. `TabBook` assigns every
 * Settlement an identifier of its own when it applies it, and `TabSettlement`
 * echoes it in the same transaction, so one word names one Settlement on both
 * sides. A transaction hash is not an identity: a batch settles several tabs in
 * one Monad transaction, and the hash would name all of them.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpStatusOf, type TabError } from "@tabai/shared";
import { parseCursor, parsePageSize, toPage } from "../cursor.js";
import { isHexAddress, isHexWord, type RegistryReads, type SettlementFilter } from "../queries.js";
import { DEFAULT_STREAM } from "../sink.js";

const fail = (c: Context, error: TabError): Response =>
  c.json({ error }, httpStatusOf(error) as ContentfulStatusCode);

const invalid = (field: string, expected: string): TabError => ({
  category: "VALIDATION",
  code: "PARAMETER_MALFORMED",
  message: `${field} must be ${expected}`,
  retryable: false,
  details: { field },
});

/** Parses the shared `agent`, `serviceId`, `asset` filter, or answers the first malformed one. */
function parseFilter(c: Context): { ok: true; filter: SettlementFilter } | { ok: false; response: Response } {
  const agent = c.req.query("agent")?.toLowerCase();
  const serviceId = c.req.query("serviceId")?.toLowerCase();
  const asset = c.req.query("asset")?.toLowerCase();
  if (agent !== undefined && !isHexAddress(agent)) {
    return { ok: false, response: fail(c, invalid("agent", "a 20-byte hex address")) };
  }
  if (serviceId !== undefined && !isHexWord(serviceId)) {
    return { ok: false, response: fail(c, invalid("serviceId", "a 32-byte hex word")) };
  }
  if (asset !== undefined && !isHexAddress(asset)) {
    return { ok: false, response: fail(c, invalid("asset", "a 20-byte hex address")) };
  }
  return { ok: true, filter: { agent, serviceId, asset } };
}

export function createSettlementRoutes(reads: RegistryReads): Hono {
  const app = new Hono();

  /**
   * `GET /settlements`: newest first, paged.
   * Query: `agent`, `serviceId`, `asset`, `limit`, `cursor`.
   */
  app.get("/settlements", async (c) => {
    const parsed = parseFilter(c);
    if (!parsed.ok) return parsed.response;
    const pageSize = parsePageSize(c.req.query("limit"));
    if (!pageSize.ok) return fail(c, pageSize.error);
    const cursor = parseCursor(c.req.query("cursor"));
    if (!cursor.ok) return fail(c, cursor.error);
    const rows = await reads.settlements(parsed.filter, pageSize.value, cursor.value);
    const page = toPage(rows, pageSize.value, (row) => ({
      blockNumber: row.monad.blockNumber,
      logIndex: row.monad.logIndex,
    }));
    return c.json({
      index: await reads.horizon(DEFAULT_STREAM),
      settlements: page.items,
      nextCursor: page.nextCursor,
    });
  });

  /** `GET /settlements/:settlementId`: one Settlement, with the transaction that paid it. */
  app.get("/settlements/:settlementId", async (c) => {
    const settlementId = c.req.param("settlementId").toLowerCase();
    if (!isHexWord(settlementId)) {
      return fail(c, invalid("settlementId", "a 32-byte hex word"));
    }
    const settlement = await reads.settlementById(settlementId);
    if (settlement === null) {
      return fail(c, {
        category: "NOT_FOUND",
        code: "SETTLEMENT_NOT_INDEXED",
        message: "no Settlement is indexed under that id",
        retryable: false,
        details: { settlementId },
      });
    }
    return c.json({ index: await reads.horizon(DEFAULT_STREAM), settlement });
  });

  /**
   * `GET /deliveries`: metered deliveries, newest first, paged.
   * Query: `agent`, `serviceId`, `asset`, `limit`, `cursor`.
   */
  app.get("/deliveries", async (c) => {
    const parsed = parseFilter(c);
    if (!parsed.ok) return parsed.response;
    const pageSize = parsePageSize(c.req.query("limit"));
    if (!pageSize.ok) return fail(c, pageSize.error);
    const cursor = parseCursor(c.req.query("cursor"));
    if (!cursor.ok) return fail(c, cursor.error);
    const rows = await reads.deliveries(parsed.filter, pageSize.value, cursor.value);
    const page = toPage(rows, pageSize.value, (row) => ({
      blockNumber: row.monad.blockNumber,
      logIndex: row.monad.logIndex,
    }));
    return c.json({
      index: await reads.horizon(DEFAULT_STREAM),
      deliveries: page.items,
      nextCursor: page.nextCursor,
    });
  });

  return app;
}
