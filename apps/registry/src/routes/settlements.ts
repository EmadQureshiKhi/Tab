/**
 * Verified Settlement reads: the cursor-paginated feed, and one Settlement by its
 * identity. (R24.4)
 *
 * ## The identity is the replay key
 *
 * `/settlements/:replayKey` and nothing else. A transaction hash is not an
 * identity: one Creditcoin transaction can carry several Verified Settlements, and
 * so can one Source Chain transaction, so a route keyed on either would sometimes
 * name more than one thing. The packed `(chainKey, blockHeight, txIndex, logIndex)`
 * tuple names exactly one, on chain and here, which is also why it is what the
 * cursor and the clearing lineage are keyed on.
 *
 * ## Unauthenticated, deliberately
 *
 * Every field served here restates a public chain fact that any node will hand to
 * anyone who asks, and nothing on this router writes. There is therefore nothing to
 * authenticate *for* — which is worth stating rather than leaving implicit, because
 * an unauthenticated network surface should be a decision and not an omission. What
 * the deployment does owe is a rate limit at its edge, since `limit` is capped here
 * but request volume is not.
 *
 * Requirements: 24.4, 24.1
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { httpStatusOf, type TabError } from "@tabai/shared";

import { latestClearingState } from "../clearing.js";
import { parseCursor, parsePageSize, toPage } from "../cursor.js";
import { isChainKey, isHexAddress, isHexWord, type RegistryReads } from "../queries.js";
import { DEFAULT_STREAM } from "../sink.js";

/** One failed read, as the status its category maps to. */
const fail = (c: Context, error: TabError): Response =>
  c.json({ error }, httpStatusOf(error) as ContentfulStatusCode);

const invalid = (field: string, expected: string): TabError => ({
  category: "VALIDATION",
  code: "PARAMETER_MALFORMED",
  message: `${field} must be ${expected}`,
  retryable: false,
  details: { field },
});

export function createSettlementRoutes(reads: RegistryReads): Hono {
  const app = new Hono();

  /**
   * A page of Verified Settlements, newest first.
   *
   * Query: `agent`, `serviceId`, `asset`, `chainKey`, `limit`, `cursor`. Every
   * filter is exact equality, and every one is optional, so an unfiltered call is
   * the whole feed.
   */
  app.get("/settlements", async (c) => {
    const agent = c.req.query("agent")?.toLowerCase();
    const serviceId = c.req.query("serviceId")?.toLowerCase();
    const asset = c.req.query("asset")?.toLowerCase();
    const chainKey = c.req.query("chainKey");

    if (agent !== undefined && !isHexAddress(agent)) {
      return fail(c, invalid("agent", "a 20-byte hex address"));
    }
    if (serviceId !== undefined && !isHexWord(serviceId)) {
      return fail(c, invalid("serviceId", "a 32-byte hex word"));
    }
    if (asset !== undefined && !isHexAddress(asset)) {
      return fail(c, invalid("asset", "a 20-byte hex address"));
    }
    if (chainKey !== undefined && !isChainKey(chainKey)) {
      return fail(c, invalid("chainKey", "a decimal uint64"));
    }

    const pageSize = parsePageSize(c.req.query("limit"));
    if (!pageSize.ok) return fail(c, pageSize.error);
    const cursor = parseCursor(c.req.query("cursor"));
    if (!cursor.ok) return fail(c, cursor.error);

    const rows = await reads.settlements(
      { agent, serviceId, asset, chainKey },
      pageSize.value,
      cursor.value,
    );
    const page = toPage(rows, pageSize.value, (row) => ({
      blockNumber: row.creditcoin.blockNumber,
      logIndex: row.creditcoin.logIndex,
    }));

    return c.json({
      index: await reads.horizon(DEFAULT_STREAM),
      settlements: page.items,
      nextCursor: page.nextCursor,
    });
  });

  /**
   * One Verified Settlement, with its clearing lineage.
   *
   * The lineage is every clearing state observed under this replay key, oldest
   * first, and `state` is the furthest the lifecycle reached. `declined` can never
   * appear in either: a decline creates no clearing, so
   * `ProvisionalClearingDeclined` carries no identity to join on, and it is
   * reported on the Agent read keyed by its Source Chain transaction hash instead.
   * That is a structural absence and not a gap — and a decline is not a failed
   * Settlement in any case. It says free Bond did not cover an observation, so the
   * Open Tab was left alone until the Verified Settlement arrived.
   */
  app.get("/settlements/:replayKey", async (c) => {
    const replayKey = c.req.param("replayKey").toLowerCase();
    if (!isHexWord(replayKey)) {
      return fail(c, invalid("replayKey", "a 32-byte hex word"));
    }

    const settlement = await reads.settlementByReplayKey(replayKey);
    if (settlement === null) {
      return fail(c, {
        category: "NOT_FOUND",
        code: "SETTLEMENT_NOT_INDEXED",
        message: "no Verified Settlement is indexed under that replay key",
        retryable: false,
        details: { replayKey },
      });
    }

    const lineage = await reads.clearingLineage(replayKey);
    const latest = latestClearingState(
      lineage.map((event) => ({
        state: event.state,
        blockNumber: event.creditcoin.blockNumber,
        logIndex: event.creditcoin.logIndex,
      })),
    );

    return c.json({
      index: await reads.horizon(DEFAULT_STREAM),
      settlement,
      clearing: {
        state: latest?.state ?? null,
        lineage,
        note: "a declined observation carries no clearing identity and cannot appear in a lineage keyed by one; a decline is not a failed Settlement",
      },
    });
  });

  return app;
}
