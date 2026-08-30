/**
 * Agent credit reads: Credit Limit, Open Tab, headroom, and delinquency. (R24.1)
 *
 * ## The Credit Limit is reported as unavailable, and that is the considered answer
 *
 * `TabBook.creditLimit(agent, asset, witness)` answers only against a
 * `LimitWitness` whose records fold to the stored history commitment, and **every
 * Verified Settlement advances that commitment**. So a mirrored history is stale the
 * instant a settlement lands, and the witness path then reverts
 * `HistoryLengthMismatch` rather than returning a figure. Three options were open,
 * and this is what became of each.
 *
 * *Recompute `LimitLib` here.* `TabBook._recordOf` commits eight fields per
 * Settlement. Five are reachable from the indexed rows — `serviceId`, `asset`, and
 * `amount` from `SettlementRecorded`, `settledAt` from the log's block timestamp,
 * and `curated` from the registration tier plus applied tier changes. Three are
 * not: `firstDeliveryAt` rides on `TabBook.DeliveryRecorded`, `bonded` and the
 * per-counterparty Bond amounts on `Bond`'s ledger events, and none of those three
 * events is in this service's surface. Two of `LimitLib`'s four filters rest on
 * exactly those fields, and both caps are computed from them, so the result would
 * not be an approximation of the Credit Limit — it would be a different number
 * wearing its name.
 *
 * *Serve the last successfully read value with its staleness.* There is no first
 * successful read to cache, for the same reason: assembling a witness needs the
 * same three fields.
 *
 * *Report the inputs and name the gap.* This is what the route does. `creditLimit`
 * and `headroom` come back `null` beside a machine-readable `unavailable` block
 * that names each missing input and the event that carries it, and everything the
 * index does hold is reported in full: the settled history, the last observed Open
 * Tab per tab with its block, delinquency, bound addresses, and declined
 * observations. Returning a plausible number instead would be the one outcome that
 * cannot be checked against the chain, which is the property this whole read layer
 * exists to preserve.
 *
 * The route to a real figure is not unknown, only out of this task's reach: index
 * `HistoryExtended`, which carries the committed record in full and exists so a
 * third party can rebuild the witness from logs alone, and either fold it here or
 * hand it to `TabBook.creditLimit`. That is a schema change, and the schema belongs
 * to the indexer.
 *
 * ## Open Tab is an observation, not the live figure
 *
 * An Open Tab moves both ways. A Verified Settlement reduces it, and that reduction
 * is indexed as `SettlementApplied.openAfter`. A Metered Delivery raises it, and
 * `DeliveryRecorded` is not indexed. So what is reported is the tab as at its last
 * settlement, labelled as such, with the block it was observed in. It is a lower
 * bound on the tab now, and the live figure is `TabBook.assetOpen(agent, asset)` — a
 * public read that needs no signature.
 *
 * ## Prepaid credit is exact, and it is the only figure here that is
 *
 * Every other derived number on this route is hedged, because the events behind it
 * are incomplete. Prepaid credit is the exception. `TabBook` raises `tab.prepaid` in
 * exactly two places, `_applyOrdinarySettlement` and `_confirmProvisional`, and both
 * emit `SettlementApplied` carrying the rise as `toPrepaid`. It lowers `tab.prepaid`
 * in exactly one place, `_recordOnTab`, which emits `PrepaidConsumed` carrying the
 * fall as `consumed`. Both events are indexed, and there is no third mover, so the
 * difference is the balance as at the index horizon rather than an observation as at
 * some last settlement.
 *
 * That is what makes a prepaid-funded delivery explain itself. An Open Tab that did
 * not move across a delivery used to be indistinguishable from no delivery at all;
 * now the draw that paid for it is a row, naming what was spent, what was left, and
 * how much of the same charge had to be borrowed once the balance ran out.
 *
 * The borrowing figure is the one exception to the exception, and is labelled a lower
 * bound wherever it is served: a delivery that drew no prepaid credit emits no
 * `PrepaidConsumed`, so only borrowing that happened on a draw is counted. The whole
 * of it rides on `DeliveryRecorded`, which is still not indexed.
 *
 * ## Unauthenticated, deliberately
 *
 * Public chain data, no writes, nothing to authenticate for. Rate limiting is the
 * deployment's job at its edge.
 *
 * Requirements: 24.1, 24.7
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { httpStatusOf, type TabError } from "@tabai/shared";

import { parseCursor, parsePageSize, toPage } from "../cursor.js";
import type { CreditChainReader } from "../chain-reads.js";
import {
  computeAgentCredit,
  creditWithheld,
  type AgentCreditView,
  type CreditLimitView,
  type HeadroomView,
} from "../credit-service.js";
import {
  isHexAddress,
  type AgentAssetTotalsRow,
  type DelinquencyRow,
  type PrepaidObservationRow,
  type PrepaidTotalsRow,
  type RegistryReads,
  type TabObservationRow,
} from "../queries.js";
import { DEFAULT_STREAM } from "../sink.js";

const fail = (c: Context, error: TabError): Response =>
  c.json({ error }, httpStatusOf(error) as ContentfulStatusCode);

/** Sums base-unit strings without ever touching a float. */
const sumBaseUnits = (values: readonly string[]): string =>
  values.reduce((total, value) => total + BigInt(value), 0n).toString();

/** One Asset's credit picture for one Agent. */
interface AgentAssetView {
  readonly asset: string;
  readonly creditLimit: CreditLimitView;
  readonly headroom: HeadroomView;
  readonly openTab: {
    readonly observed: string;
    readonly basis: string;
    readonly liveRead: string;
    readonly tabs: readonly TabObservationRow[];
  };
  readonly delinquency: {
    readonly delinquent: boolean;
    readonly openCount: number;
    readonly basis: string;
    readonly tabs: readonly DelinquencyRow[];
  };
  readonly prepaid: {
    readonly balance: string | null;
    readonly funded: string | null;
    readonly consumed: string | null;
    readonly borrowedOnDraw: string | null;
    readonly drawCount: number;
    readonly basis: string;
    readonly liveRead: string;
    readonly tabs: readonly PrepaidObservationRow[];
  };
  readonly settlements: AgentAssetTotalsRow | null;
}

/**
 * The prepaid balance is exact, and this says why in the response itself.
 *
 * Every other derived figure on this route is hedged, so a reader has no reason to
 * believe an unhedged one unless it argues for itself. `tab.prepaid` is raised only
 * by `SettlementApplied.toPrepaid` and lowered only by `PrepaidConsumed.consumed`,
 * both of which this service indexes, so the difference is the balance rather than an
 * approximation of it.
 */
const PREPAID_BASIS =
  "SettlementApplied.toPrepaid less PrepaidConsumed.consumed, which is exact: TabBook raises prepaid credit only on a settlement and lowers it only on a metered delivery, and both events are indexed";

/**
 * Borrowing is the one prepaid figure that is a lower bound, and it is labelled so.
 *
 * A delivery that drew no prepaid credit emits no PrepaidConsumed at all, so what is
 * summed here is the borrowing that happened on a draw and never the whole of it.
 */
const BORROWED_BASIS =
  "PrepaidConsumed.openAdded, the part of a prepaid-funded delivery the balance could not cover; a delivery that drew no prepaid credit emits nothing, so this is a lower bound on borrowing and DeliveryRecorded is not indexed";

/** What a process with no Creditcoin endpoint serves in place of a figure. */
const NO_CHAIN_READER = (): AgentCreditView =>
  creditWithheld(
    "CHAIN_READER_UNCONFIGURED",
    "this process has no Creditcoin endpoint wired in, so the recomputed figure cannot be checked against TabBook and is withheld rather than served unchecked",
  );

/**
 * Folds one Agent's rows into one entry per Asset, computing credit per Asset.
 *
 * The Asset set is the union of four sources rather than any one of them, so an
 * Asset that only ever appears in a delinquency, or only in a committed history
 * with no settlement totals yet, is still reported. Taking the settlement totals
 * alone would hide exactly the Agent a credit view most needs to show.
 *
 * The Credit Limit is computed per Asset rather than once, because a Credit Limit
 * is per Asset by construction (R13.3) and no Asset's history may inform another's.
 */
async function toAssetViews(
  reads: RegistryReads,
  chain: CreditChainReader | undefined,
  agent: string,
  horizonBlock: number | null,
  totals: readonly AgentAssetTotalsRow[],
  observations: readonly TabObservationRow[],
  delinquencies: readonly DelinquencyRow[],
  creditAssets: readonly { readonly asset: string }[],
  prepaidTotals: readonly PrepaidTotalsRow[],
  prepaidObservations: readonly PrepaidObservationRow[],
): Promise<readonly AgentAssetView[]> {
  const assets = new Set<string>([
    ...totals.map((row) => row.asset),
    ...observations.map((row) => row.asset),
    ...delinquencies.map((row) => row.asset),
    ...creditAssets.map((row) => row.asset),
    ...prepaidTotals.map((row) => row.asset),
    ...prepaidObservations.map((row) => row.asset),
  ]);

  return Promise.all([...assets].sort().map(async (asset) => {
    const tabs = observations.filter((row) => row.asset === asset);
    const flags = delinquencies.filter((row) => row.asset === asset);
    const prepaid = prepaidTotals.find((row) => row.asset === asset) ?? null;
    const draws = prepaidObservations.filter((row) => row.asset === asset);
    const unresolved = flags.filter((row) => !row.resolved);
    const credit =
      chain === undefined
        ? NO_CHAIN_READER()
        : await computeAgentCredit(reads, chain, {
            agent,
            asset,
            horizonBlock,
            delinquent: unresolved.length > 0,
          });
    return {
      asset,
      creditLimit: credit.creditLimit,
      headroom: credit.headroom,
      openTab: {
        observed: sumBaseUnits(tabs.map((row) => row.openAfter)),
        basis:
          "sum of the last observed Open Tab per tab, each at its own block; a Metered Delivery raises a tab and DeliveryRecorded is not indexed, so this is a lower bound",
        liveRead: "TabBook.assetOpen(agent, asset)",
        tabs,
      },
      delinquency: {
        delinquent: unresolved.length > 0,
        openCount: unresolved.length,
        basis:
          "TabDelinquent, with the contract's own lift applied: a delinquency is resolved once a later SettlementApplied for the same tab reports openAfter of zero, which is exactly when TabBook clears the flag",
        tabs: flags,
      },
      prepaid: {
        // Null rather than "0" where nothing was ever funded or drawn: no ledger is a
        // different fact from an empty one, and only one of the two can be checked.
        balance: prepaid?.balance ?? null,
        funded: prepaid?.fundedTotal ?? null,
        consumed: prepaid?.consumedTotal ?? null,
        borrowedOnDraw: prepaid?.borrowedOnDraw ?? null,
        drawCount: prepaid?.drawCount ?? 0,
        basis: `${PREPAID_BASIS}. Borrowing: ${BORROWED_BASIS}`,
        liveRead: "TabBook.tabOf(TabBook.tabIdOf(agent, serviceId, asset)).prepaid",
        tabs: draws,
      },
      settlements: totals.find((row) => row.asset === asset) ?? null,
    };
  }));
}

export function createAgentRoutes(reads: RegistryReads, chain?: CreditChainReader): Hono {
  const app = new Hono();

  /** A page of Agents, most recently settled first. */
  app.get("/agents", async (c) => {
    const pageSize = parsePageSize(c.req.query("limit"));
    if (!pageSize.ok) return fail(c, pageSize.error);
    const cursor = parseCursor(c.req.query("cursor"));
    if (!cursor.ok) return fail(c, cursor.error);

    const rows = await reads.agents(pageSize.value, cursor.value);
    const page = toPage(rows, pageSize.value, (row) => ({
      blockNumber: row.creditcoin.blockNumber,
      logIndex: row.creditcoin.logIndex,
    }));

    return c.json({
      index: await reads.horizon(DEFAULT_STREAM),
      agents: page.items,
      nextCursor: page.nextCursor,
      // Deliberately no per-row Credit Limit. A figure costs a witness rebuild and
      // four chain reads per Agent and Asset, so a page of fifty would be hundreds
      // of round trips for a listing nobody reads a limit off. The detail route
      // serves it, and this names where.
      creditLimit: {
        value: null,
        servedBy: "GET /agents/:agent, per Asset",
        why: "a Credit Limit is per Asset and costs a witness rebuild plus a cross-check, so it is not computed for every row of a page",
      },
    });
  });

  /**
   * One Agent's credit picture, per Asset.
   *
   * 200 with empty arrays for an address the index has never seen, not 404. An
   * Agent is a Creditcoin account address and there is no identity token to be
   * absent — no rows means no activity, which is a truthful answer about a real
   * address. A 404 would claim the address does not exist, which this service has no
   * way to know. That is the opposite of the Service read, where an unregistered id
   * names nothing on chain and 404 is correct.
   */
  app.get("/agents/:agent", async (c) => {
    const agent = c.req.param("agent").toLowerCase();
    if (!isHexAddress(agent)) {
      return fail(c, {
        category: "VALIDATION",
        code: "PARAMETER_MALFORMED",
        message: "agent must be a 20-byte hex address",
        retryable: false,
        details: { field: "agent" },
      });
    }

    const [index, totals, observations, delinquencies, bound, declined, creditAssets, prepaidTotals, prepaidDraws] =
      await Promise.all([
        reads.horizon(DEFAULT_STREAM),
        reads.agentAssetTotals(agent),
        reads.tabObservations(agent),
        reads.delinquencies(agent),
        reads.boundAddresses(agent),
        reads.declinedObservations(agent),
        reads.creditAssets(agent),
        reads.prepaidTotals(agent),
        reads.prepaidObservations(agent),
      ]);

    return c.json({
      index,
      agent,
      assets: await toAssetViews(
        reads,
        chain,
        agent,
        index.lastBlock,
        totals,
        observations,
        delinquencies,
        creditAssets,
        prepaidTotals,
        prepaidDraws,
      ),
      boundAddresses: bound,
      declinedObservations: {
        note: "a decline is not a failed Settlement: free Bond did not cover an observation, so the Open Tab was left alone until the Verified Settlement arrived. A decline creates no clearing, so it carries no clearing identity and is keyed by its Source Chain transaction hash",
        observations: declined,
      },
    });
  });

  return app;
}
