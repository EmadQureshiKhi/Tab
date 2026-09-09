/**
 * The Service directory: tier, price list, Settlement Window, Bond, accepted
 * Assets, and any pending timelocked change with its ETA.
 *
 * ## The timelock rule this router exists to get right
 *
 * `ServiceRegistry` holds every change to a tier, a price, a Collection Address, an
 * accepted Asset, or a Settlement Window for 48 hours, and **keeps serving the
 * previously applied value for the whole of that hold**. So a
 * pending change is reported *beside* the current value and never in place of it. A
 * reader that showed the queued figure as current would be reporting a price the
 * chain does not charge and a tier that does not yet apply.
 *
 * Every served value therefore carries a `source`, naming either `registration` or
 * the `changeId` of the applied change that last rewrote it, together with that
 * log's own block. `pendingChanges` is a separate array with each change's ETA. The
 * two cannot be confused, which is the whole point of separating them.
 *
 * ## Tier gates weight, not eligibility
 *
 * A Permissionless Tier Service can be paid, can hold Open Tabs, and its
 * Settlements verify and apply exactly like a Curated one's. What the tier decides
 * is how much those Settlements weigh in `LimitLib`: zero at the Permissionless
 * Tier, counted at the Curated Tier when the Service also holds a Bond in
 * the same Asset. `tier.creditWeight` says so on every row, so nothing here
 * can be read as permission to transact.
 */

import { AbiCoder } from "ethers";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { httpStatusOf, type TabError } from "@tabai/shared";

import { TIERS } from "../enum-names.js";
import { parseCursor, parsePageSize, toPage } from "../cursor.js";
import type { CreditChainReader } from "../chain-reads.js";
import { identityOf, type IdentityDependencies } from "../identity-service.js";
import { BOND_BASIS, verifyBondLedgers, type ServiceBondView } from "../credit-service.js";
import {
  isHexWord,
  type CollectionRow,
  type Provenance,
  type RegistryChangeRow,
  type RegistryReads,
  type ServiceRegistrationRow,
  type ToolPriceRow,
  type ValueSource,
} from "../queries.js";
import { DEFAULT_STREAM } from "../sink.js";

const fail = (c: Context, error: TabError): Response =>
  c.json({ error }, httpStatusOf(error) as ContentfulStatusCode);

/**
 * Settlement Window applied when a change payload carries zero.
 *
 * Mirrors `ServiceRegistry.DEFAULT_SETTLEMENT_WINDOW`, which is 6 hours, and is
 * needed for exactly one case: an applied `SettlementWindow` change whose payload
 * is `0`, which the contract reads as "take the registry default". A registration
 * never needs it, because `ServiceRegistered` carries the window already resolved -
 * which is why this constant appears once, here, rather than being consulted on
 * every read.
 */
const DEFAULT_SETTLEMENT_WINDOW_SECONDS = 21_600;

/** Longest window the registry accepts, mirroring `ServiceRegistry.MAX_SETTLEMENT_WINDOW`. */
const MAX_SETTLEMENT_WINDOW_SECONDS = 86_400;

const CODER = AbiCoder.defaultAbiCoder();

/** The abi layout of each `ChangeKind` payload, from `IServiceRegistry.queueChange`. */
const PAYLOAD_TYPES: Readonly<Record<string, readonly string[]>> = {
  Tier: ["uint256"],
  Price: ["address", "bytes32", "uint256"],
  Collection: ["address", "address"],
  AcceptedAsset: ["address", "address"],
  SettlementWindow: ["uint256"],
};

/** The field names each layout decodes into, in the contract's own order. */
const PAYLOAD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Tier: ["tier"],
  Price: ["asset", "tool", "baseUnits"],
  Collection: ["asset", "to"],
  AcceptedAsset: ["asset", "collection"],
  SettlementWindow: ["seconds"],
};

/**
 * Decodes a change payload, or returns `null`.
 *
 * The bytes are stored whole by the indexer precisely because decoding them needs
 * the kind, and a wrong guess would rewrite a price or a tier in the read layer
 * while the chain says something else. So this decodes per kind and returns `null`
 * on any failure, an unknown kind from a later contract, or a payload that does
 * not match its declared layout. The raw hex is served either way, so a caller can
 * always decode it itself.
 *
 * Every decoded value is a string. A `uint256` price exceeds what a double holds
 * exactly, and the whole read layer keeps integers as text for that reason.
 */
function decodePayload(kindName: string, payload: string): Record<string, string> | null {
  const types = PAYLOAD_TYPES[kindName];
  const fields = PAYLOAD_FIELDS[kindName];
  if (types === undefined || fields === undefined) return null;
  try {
    const decoded = CODER.decode([...types], payload);
    const out: Record<string, string> = {};
    fields.forEach((field, position) => {
      out[field] = String(decoded[position]);
    });
    if (kindName === "Tier") {
      const value = Number(out["tier"]);
      out["tierName"] = TIERS[value] ?? `unknown(${out["tier"] ?? ""})`;
    }
    return out;
  } catch {
    return null;
  }
}

interface ServiceView {
  readonly serviceId: string;
  readonly operator: string;
  readonly tier: { readonly value: number; readonly name: string; readonly creditWeight: string } & {
    readonly source: ValueSource;
  };
  readonly settlementWindowSeconds: { readonly value: number; readonly source: ValueSource };
  readonly acceptedAssets: readonly {
    readonly asset: string;
    readonly collection: string;
  }[];
  readonly collections: readonly CollectionRow[];
  readonly prices: readonly ToolPriceRow[];
  readonly bond: readonly ServiceBondView[];
  readonly pendingChanges: readonly {
    readonly changeId: string;
    readonly kind: number;
    readonly kindName: string;
    readonly eta: number | null;
    readonly etaIso: string | null;
    readonly payload: string;
    readonly decoded: Record<string, string> | null;
    readonly queuedAt: Provenance;
  }[];
  readonly registeredAt: Provenance;
}

const creditWeightOf = (tierName: string): string =>
  tierName === "Curated" ? "counted-when-bonded" : "zero";

/** `null` unless the value names a known tier member. */
const tierNameOf = (value: number): string => TIERS[value] ?? `unknown(${value})`;

/**
 * Folds one Service's rows into the directory entry.
 *
 * The two values that can only be reached through a payload are handled here: the
 * tier and the Settlement Window. Prices and Collection Addresses need no decoding
 * at all, because `ServiceRegistry` emits `ToolPriceSet` and
 * `CollectionRegistered` when it applies a change to either, so the applied value
 * arrives as its own event and the payload is redundant for them.
 */
function toServiceView(
  registration: ServiceRegistrationRow,
  applied: readonly RegistryChangeRow[],
  pending: readonly RegistryChangeRow[],
  prices: readonly ToolPriceRow[],
  collections: readonly CollectionRow[],
  bonds: readonly ServiceBondView[],
): ServiceView {
  let tier = registration.tier;
  let tierSource: ValueSource = { appliedBy: "registration", monad: registration.monad };
  let window = registration.settlementWindowSeconds;
  let windowSource: ValueSource = { appliedBy: "registration", monad: registration.monad };

  for (const change of applied) {
    if (change.changeKindName === "Tier") {
      const decoded = decodePayload("Tier", change.payload);
      const value = decoded === null ? null : Number(decoded["tier"]);
      if (value !== null && Number.isInteger(value) && value >= 0) {
        tier = value;
        tierSource = { appliedBy: change.changeId, monad: change.monad };
      }
    }
    if (change.changeKindName === "SettlementWindow") {
      const decoded = decodePayload("SettlementWindow", change.payload);
      const raw = decoded === null ? null : Number(decoded["seconds"]);
      if (raw !== null && Number.isSafeInteger(raw) && raw >= 0) {
        // `ServiceRegistry._decodeWindow`, exactly: zero takes the registry default,
        // and a value over the maximum is not applicable at all, so a payload above
        // it is left unapplied rather than clamped into a window the chain refused.
        const resolved = raw === 0 ? DEFAULT_SETTLEMENT_WINDOW_SECONDS : raw;
        if (resolved <= MAX_SETTLEMENT_WINDOW_SECONDS) {
          window = resolved;
          windowSource = { appliedBy: change.changeId, monad: change.monad };
        }
      }
    }
  }

  // An accepted Asset is an Asset with a Collection address that currently resolves.
  // Stake goes to the Bond escrow directly, so there is nothing else to report here.

  return {
    serviceId: registration.serviceId,
    operator: registration.operator,
    tier: {
      value: tier,
      name: tierNameOf(tier),
      creditWeight: creditWeightOf(tierNameOf(tier)),
      source: tierSource,
    },
    settlementWindowSeconds: { value: window, source: windowSource },
    acceptedAssets: collections.map((collection) => ({
      asset: collection.asset,
      collection: collection.collection,
    })),
    collections,
    prices,
    bond: bonds,
    pendingChanges: pending.map((change) => ({
      changeId: change.changeId,
      kind: change.changeKind,
      kindName: change.changeKindName,
      eta: change.eta,
      etaIso: change.eta === null ? null : new Date(change.eta * 1000).toISOString(),
      payload: change.payload,
      decoded: decodePayload(change.changeKindName, change.payload),
      queuedAt: change.monad,
    })),
    registeredAt: registration.monad,
  };
}

/**
 * The Bond view a process with no Monad endpoint serves.
 *
 * The replayed figures are still shown, because they are what this index actually
 * holds and they are checkable by anyone. What is withheld is the claim that the
 * chain agrees with them, which is the only thing the cross-check establishes.
 */
const unverifiedBonds = (rows: readonly ServiceBondView[]): readonly ServiceBondView[] =>
  rows.map((row) => ({
    ...row,
    computedAt: null,
    crossCheck: null,
    unavailable: {
      code: "CHAIN_READER_UNCONFIGURED" as const,
      message:
        "this process has no Monad endpoint wired in, so the replayed ledger could not be checked against Bond.ledgerOf",
    },
  }));

export interface ServiceRouteOptions {
  readonly chain?: CreditChainReader | undefined;
  /** ERC-8004 identity for the operator on the detail read, when configured. */
  readonly identity?: IdentityDependencies | undefined;
}

export function createServiceRoutes(reads: RegistryReads, options: ServiceRouteOptions = {}): Hono {
  const app = new Hono();
  const chain = options.chain;

  /** Hydrates a set of registrations into full directory entries in five queries. */
  const hydrate = async (
    registrations: readonly ServiceRegistrationRow[],
    horizonBlock: number | null,
  ): Promise<readonly ServiceView[]> => {
    const ids = registrations.map((registration) => registration.serviceId);
    const [applied, pending, prices, collections, ledgers] = await Promise.all([
      reads.appliedChanges(ids),
      reads.pendingChanges(ids),
      reads.toolPrices(ids),
      reads.collections(ids),
      reads.bondLedgers(ids),
    ]);
    // The ledger is replayed from Bond's own events here, then checked against
    // `Bond.ledgerOf` at the same block. Free stake is what caps every Credit Limit
    // the Service's history backs, so an unchecked one is not served as a figure.
    const bonds =
      chain === undefined
        ? unverifiedBonds(
            ledgers.map((row) => ({ ...row, basis: BOND_BASIS, computedAt: null, crossCheck: null, unavailable: null })),
          )
        : await verifyBondLedgers(chain, ledgers, horizonBlock);
    const by = <T extends { readonly serviceId: string }>(rows: readonly T[], id: string): T[] =>
      rows.filter((row) => row.serviceId === id);
    return registrations.map((registration) =>
      toServiceView(
        registration,
        by(applied, registration.serviceId),
        by(pending, registration.serviceId),
        by(prices, registration.serviceId),
        by(collections, registration.serviceId),
        by(bonds, registration.serviceId),
      ),
    );
  };

  /** A page of registered Services, most recently registered first. */
  app.get("/services", async (c) => {
    const pageSize = parsePageSize(c.req.query("limit"));
    if (!pageSize.ok) return fail(c, pageSize.error);
    const cursor = parseCursor(c.req.query("cursor"));
    if (!cursor.ok) return fail(c, cursor.error);

    const registrations = await reads.serviceRegistrations(pageSize.value, cursor.value);
    const page = toPage(registrations, pageSize.value, (row) => ({
      blockNumber: row.monad.blockNumber,
      logIndex: row.monad.logIndex,
    }));

    const index = await reads.horizon(DEFAULT_STREAM);
    return c.json({
      index,
      services: await hydrate(page.items, index.lastBlock),
      nextCursor: page.nextCursor,
    });
  });

  /**
   * One Service.
   *
   * 404 when nothing ever registered under that id, because a Service *is* its
   * registration, an unregistered id names nothing on chain. That is the opposite
   * of the Agent read, where an address with no activity is a real address with an
   * empty history and gets a 200.
   */
  app.get("/services/:serviceId", async (c) => {
    const serviceId = c.req.param("serviceId").toLowerCase();
    if (!isHexWord(serviceId)) {
      return fail(c, {
        category: "VALIDATION",
        code: "PARAMETER_MALFORMED",
        message: "serviceId must be a 32-byte hex word",
        retryable: false,
        details: { field: "serviceId" },
      });
    }

    const registration = await reads.serviceRegistration(serviceId);
    if (registration === null) {
      return fail(c, {
        category: "NOT_FOUND",
        code: "SERVICE_NOT_REGISTERED",
        message: "no ServiceRegistered log is indexed for that serviceId",
        retryable: false,
        details: { serviceId },
      });
    }

    const index = await reads.horizon(DEFAULT_STREAM);
    const [[view], identity] = await Promise.all([
      hydrate([registration], index.lastBlock),
      // The operator's ERC-8004 identity, the same way the Agent read serves it.
      // Only on the detail read: a page of fifty Services would be fifty card
      // fetches and a hundred chain reads for a listing nobody reads a card off.
      identityOf(reads, options.identity, registration.operator),
    ]);
    return c.json({ index, service: view, identity });
  });

  return app;
}
