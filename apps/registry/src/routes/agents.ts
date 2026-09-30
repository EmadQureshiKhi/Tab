/**
 * Agent credit reads: Credit Limit, Open Tab, headroom, delinquency, prepaid
 * credit, and the `LimitWitness` a metering Service needs.
 *
 * ## The Credit Limit is recomputed, then confirmed by the chain
 *
 * `TabBook.creditLimit(agent, asset, witness)` answers only against a
 * `LimitWitness` whose records fold to the stored history commitment. The index
 * rebuilds that witness from `HistoryExtended`, which carries every committed
 * `LimitLib.SettlementRecord` in full, and from the Bond ledger and
 * `AuthorisationSet` rows for the counterparties. `credit-service.ts` recomputes
 * `LimitLib` over it at the index horizon block and serves the figure only when
 * `TabBook.creditLimit` at that same block returns the same number. Where the
 * chain disagrees or cannot be read, `creditLimit` and `headroom` come back `null`
 * beside a machine-readable `unavailable` block naming why, with the recomputed
 * figure attached so nothing is hidden. Headroom is checked against
 * `TabBook.headroom` the same way.
 *
 * ## Open Tab is an observation, not the live figure
 *
 * An Open Tab moves both ways. A Settlement reduces it, and that reduction is
 * indexed as `SettlementApplied.openAfter`. A Metered Delivery raises it, and
 * `DeliveryRecorded` carries the charge but not the running total, so the tab is
 * reported as at its last settlement, labelled as such, with the block it was
 * observed in. It is a lower bound on the tab now, and the live figure is
 * `TabBook.assetOpen(agent, asset)`, a public read that needs no signature. The
 * headroom block carries that read at the horizon block.
 *
 * ## Prepaid credit is exact
 *
 * `TabBook` raises `tab.prepaid` in exactly one place, `applySettlement`, which
 * emits `SettlementApplied` carrying the rise as `toPrepaid`. It lowers
 * `tab.prepaid` in exactly one place, `_recordOnTab`, which emits
 * `PrepaidConsumed` carrying the fall as `consumed`. Both events are indexed, and
 * there is no third mover, so the difference is the balance as at the index
 * horizon rather than an observation as at some last settlement.
 *
 * That is what makes a prepaid-funded delivery explain itself. An Open Tab that
 * does not move across a delivery would otherwise be indistinguishable from no
 * delivery at all; the draw that paid for it is a row, naming what was spent,
 * what was left, and how much of the same charge had to be borrowed once the
 * balance ran out.
 *
 * The borrowing figure is labelled a lower bound wherever it is served: a
 * delivery that drew no prepaid credit emits no `PrepaidConsumed`, so only
 * borrowing that happened on a draw is counted here. Every delivery, with its
 * full charge, is served by `GET /deliveries`.
 *
 * ## Identity and labels are context, served beside the facts
 *
 * Two blocks on the detail read describe the address rather than its credit.
 * `identity` is the Agent's ERC-8004 registration, folded from the Identity
 * registry's own events by the same indexer, with the agent card and the
 * reputation summary fetched live and each carrying its own status; see
 * `identity-service.ts`. `labels` is Nansen's view of the address, an off-chain
 * overlay with a named source and a fetch time, or a stated reason it is absent;
 * see `nansen.ts`. Neither feeds any figure above. A reader can weigh them; this
 * service does not.
 *
 * ## Unauthenticated, deliberately
 *
 * Public chain data, no writes, nothing to authenticate for. Rate limiting is the
 * deployment's job at its edge.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { httpStatusOf, type TabError } from "@tabai/shared";

import { parseCursor, parsePageSize, toPage } from "../cursor.js";
import type { CreditChainReader } from "../chain-reads.js";
import { identityOf, reputationOfAddress, type IdentityDependencies } from "../identity-service.js";
import { NANSEN_KEY_MISSING, type LabelSource } from "../nansen.js";
import {
  computeAgentCredit,
  creditWithheld,
  rebuildWitness,
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
 * The Open Tab and borrowing figures on this route are hedged, so a reader has no
 * reason to believe an unhedged one beside them unless it argues for itself. `tab.prepaid` is raised only
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
  "PrepaidConsumed.openAdded, the part of a prepaid-funded delivery the balance could not cover; a delivery that drew no prepaid credit emits nothing, so this is a lower bound on borrowing";

/** What a process with no Monad endpoint serves in place of a figure. */
const NO_CHAIN_READER = (): AgentCreditView =>
  creditWithheld(
    "CHAIN_READER_UNCONFIGURED",
    "this process has no Monad endpoint wired in, so the recomputed figure cannot be checked against TabBook and is withheld rather than served unchecked",
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
 * is per Asset by construction and no Asset's history may inform another's.
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
          "sum of the last observed Open Tab per tab, each at its own block; a Metered Delivery raises a tab between observations, so this is a lower bound",
        liveRead: "TabBook.assetOpen(agent, asset)",
        tabs,
      },
      delinquency: {
        delinquent: unresolved.length > 0,
        openCount: unresolved.length,
        basis:
          "TabDelinquent, resolved by a later TabDelinquencyCleared for the same tab, which TabBook emits exactly when the tab settles to zero",
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

export interface AgentRouteOptions {
  readonly chain?: CreditChainReader | undefined;
  /** ERC-8004 identity, when configured for this deployment. */
  readonly identity?: IdentityDependencies | undefined;
  /** Nansen labels. Defaults to the source that states the key is missing. */
  readonly labels?: LabelSource | undefined;
}

export function createAgentRoutes(reads: RegistryReads, options: AgentRouteOptions = {}): Hono {
  const app = new Hono();
  const chain = options.chain;
  const labels = options.labels ?? NANSEN_KEY_MISSING;

  /** A page of Agents, most recently settled first. */
  app.get("/agents", async (c) => {
    const pageSize = parsePageSize(c.req.query("limit"));
    if (!pageSize.ok) return fail(c, pageSize.error);
    const cursor = parseCursor(c.req.query("cursor"));
    if (!cursor.ok) return fail(c, cursor.error);

    const rows = await reads.agents(pageSize.value, cursor.value);
    const page = toPage(rows, pageSize.value, (row) => ({
      blockNumber: row.monad.blockNumber,
      logIndex: row.monad.logIndex,
    }));

    return c.json({
      index: await reads.horizon(DEFAULT_STREAM),
      agents: page.items,
      nextCursor: page.nextCursor,
      // Deliberately no per-row Credit Limit. A figure costs a witness rebuild and
      // seven chain reads per Agent and Asset, so a page of fifty would be hundreds
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
   * Agent is a Monad account address and there is no identity token to be
   * absent, no rows means no activity, which is a truthful answer about a real
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

    const [index, totals, observations, delinquencies, creditAssets, prepaidTotals, prepaidDraws, identity, addressLabels] =
      await Promise.all([
        reads.horizon(DEFAULT_STREAM),
        reads.agentAssetTotals(agent),
        reads.tabObservations(agent),
        reads.delinquencies(agent),
        reads.creditAssets(agent),
        reads.prepaidTotals(agent),
        reads.prepaidObservations(agent),
        identityOf(reads, options.identity, agent),
        labels.labelsFor(agent),
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
      identity,
      labels: addressLabels,
    });
  });

  /**
   * The ERC-8004 reputation of every agent the address holds, without the
   * credit picture or the registration file.
   *
   * This is the read a Service makes after a Settlement to find the agentId it
   * writes feedback against, and the read anyone makes to see what Tab
   * Services wrote: per agent, the whole-registry summary and the summary over
   * Service operators under Tab's tags. `reputation` is `null` when identity is
   * off for this deployment, and `agents` is empty for an address that holds
   * no agent. Nothing here feeds the Credit Limit.
   */
  app.get("/agents/:agent/reputation", async (c) => {
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
    const [index, reputation] = await Promise.all([
      reads.horizon(DEFAULT_STREAM),
      reputationOfAddress(reads, options.identity, agent),
    ]);
    return c.json({ index, agent, reputation });
  });

  /**
   * The `LimitWitness` for one Agent and Asset, as the index holds it.
   *
   * This is the route a metering Service reads before `recordDelivery`. The
   * history is every `HistoryExtended` record in commitment order, the bonds are
   * one entry per counterparty, and `commitment` is what the history folds to,
   * which the Service checks against `TabBook.historyCommitment` before it
   * trusts a byte of this: a witness that does not fold is refused on chain, so
   * serving one costs the reader a simulation and nothing else. `index.lastBlock`
   * is the block the witness is complete to; a Settlement after it is the
   * reader's to scan for, which is why the block is stated rather than implied.
   *
   * 200 with an empty history for an Agent the index has never seen, for the
   * same reason the credit read answers 200: no rows is the truthful answer
   * about a real address. A witness the index cannot rebuild, because a row is
   * missing or the rows disagree with themselves, is 409 naming why, never a
   * partial list dressed as a whole one.
   */
  app.get("/agents/:agent/witness/:asset", async (c) => {
    const agent = c.req.param("agent").toLowerCase();
    const asset = c.req.param("asset").toLowerCase();
    if (!isHexAddress(agent) || !isHexAddress(asset)) {
      return fail(c, {
        category: "VALIDATION",
        code: "PARAMETER_MALFORMED",
        message: "agent and asset must each be a 20-byte hex address",
        retryable: false,
        details: { field: isHexAddress(agent) ? "asset" : "agent" },
      });
    }

    const [index, rebuilt] = await Promise.all([reads.horizon(DEFAULT_STREAM), rebuildWitness(reads, agent, asset)]);
    if (!rebuilt.ok) {
      return fail(c, {
        category: "CONFLICT",
        code: `WITNESS_${rebuilt.unavailable.code}`,
        message: rebuilt.unavailable.message,
        retryable: true,
        details: { agent, asset },
      });
    }

    return c.json({
      index,
      agent,
      asset,
      commitment: rebuilt.summary.commitment,
      history: rebuilt.witness.history.map((record) => ({
        serviceId: record.serviceId,
        asset: record.asset,
        amount: record.amount.toString(),
        settledAt: record.settledAt.toString(),
        firstDeliveryAt: record.firstDeliveryAt.toString(),
        curated: record.curated,
        bonded: record.bonded,
      })),
      bonds: rebuilt.witness.bonds.map((bond) => ({
        serviceId: bond.serviceId,
        asset: bond.asset,
        amount: bond.amount.toString(),
      })),
      basis:
        "HistoryExtended records in commitment order and one Bond entry per counterparty, complete to index.lastBlock; fold the history and compare with TabBook.historyCommitment before trusting it",
    });
  });

  return app;
}
