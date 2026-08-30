/**
 * Decoded event to database row. The only place a chain fact is shaped for storage.
 *
 * Two rules hold throughout, and both are about not losing information:
 *
 * **Nothing is reinterpreted.** Each event maps to one row in its own table under
 * the contract's own field names. The five clearing states stay five states, a
 * decline stays a decline, and no event is folded into another. What the read
 * layer makes of the rows is the read layer's business; this module records what
 * the chain said.
 *
 * **Nothing is narrowed silently.** A `uint256` becomes a decimal string for a
 * `numeric` column, never a float. A `uint64` becomes a JavaScript number only
 * after {@link safeNumber} has checked it against the safe-integer ceiling, so a
 * value that could not survive the conversion stops the row rather than landing
 * rounded.
 *
 * Requirements: 12.6, 24.4
 */

import { enumMemberName } from "./enum-names.js";
import {
  booleanField,
  hexField,
  integerField,
  tupleField,
  type DecodedEvent,
  type IndexedEventName,
} from "./events.js";
import { TYPED_TABLES } from "./schema.js";

/**
 * One insert, addressed by the event it came from.
 *
 * Type-erased on purpose: 28 tables in one array cannot keep their individual
 * insert types through a loop, so the checking happens at each call to
 * {@link row}, where the values are compared against that one table's inferred
 * insert type. The sink then resolves the table by event name and performs a
 * single cast, which is documented where it happens.
 */
export interface TypedInsert {
  readonly event: IndexedEventName;
  readonly values: Readonly<Record<string, unknown>>;
}

/** Builds a typed insert, checking the values against the table's own insert type. */
const row = <N extends IndexedEventName>(
  event: N,
  values: (typeof TYPED_TABLES)[N]["$inferInsert"],
): TypedInsert => ({ event, values: values as Record<string, unknown> });

/**
 * A `uint64` as a JavaScript number.
 *
 * @throws Error naming the event and field when the value exceeds the safe-integer
 * range. Block heights, chain keys, and Creditcoin timestamps are nowhere near
 * `2^53`, so this never fires in practice — and if it ever does, a stopped indexer
 * is far better than a silently rounded block height that no later read can
 * detect. The coordinates that must survive the full `uint64` range travel inside
 * `replay_key`, which is stored as hex and never converted.
 */
export function safeNumber(event: DecodedEvent, field: string): number {
  const value = integerField(event, field);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `rows: ${event.name}.${field} is ${value}, beyond the safe-integer range, so it cannot be stored without rounding`,
    );
  }
  return Number(value);
}

/** A `uint256` or `uint128` as the exact decimal string a `numeric` column takes. */
const decimal = (event: DecodedEvent, field: string): string => integerField(event, field).toString();

/**
 * Shapes one decoded event as its row.
 *
 * @throws Error when a field is absent or carries an unexpected shape, which can
 * only mean the declarations in `events.ts` and the deployed contract have
 * diverged.
 */
export function toTypedInsert(event: DecodedEvent): TypedInsert {
  const envelope = { blockHash: event.envelope.blockHash, logIndex: event.envelope.logIndex };

  switch (event.name) {
    case "SettlementRecorded":
      return row("SettlementRecorded", {
        ...envelope,
        replayKey: hexField(event, "replayKey"),
        chainKey: safeNumber(event, "chainKey"),
        sourceBlockHeight: safeNumber(event, "blockHeight"),
        sourceTxIndex: safeNumber(event, "txIndex"),
        sourceLogIndex: safeNumber(event, "logIndex"),
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        payerAddress: hexField(event, "payerAddress"),
        sourceTabId: hexField(event, "sourceTabId"),
      });

    case "BondDepositRecorded":
      return row("BondDepositRecorded", {
        ...envelope,
        replayKey: hexField(event, "replayKey"),
        chainKey: safeNumber(event, "chainKey"),
        sourceBlockHeight: safeNumber(event, "blockHeight"),
        sourceTxIndex: safeNumber(event, "txIndex"),
        sourceLogIndex: safeNumber(event, "logIndex"),
        depositor: hexField(event, "depositor"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        payerAddress: hexField(event, "payerAddress"),
        party: hexField(event, "party"),
      });

    case "SettlementApplied":
      return row("SettlementApplied", {
        ...envelope,
        replayKey: hexField(event, "replayKey"),
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        applied: decimal(event, "applied"),
        toPrepaid: decimal(event, "toPrepaid"),
        openAfter: decimal(event, "openAfter"),
      });

    case "ProvisionalClearingApplied":
      return row("ProvisionalClearingApplied", {
        ...envelope,
        clearingId: hexField(event, "clearingId"),
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        sourceTxHash: hexField(event, "sourceTxHash"),
        deadline: safeNumber(event, "deadline"),
      });

    case "ProvisionalClearingConfirmed":
      return row("ProvisionalClearingConfirmed", {
        ...envelope,
        clearingId: hexField(event, "clearingId"),
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        sourceTxHash: hexField(event, "sourceTxHash"),
      });

    case "ProvisionalClearingReversed":
      return row("ProvisionalClearingReversed", {
        ...envelope,
        clearingId: hexField(event, "clearingId"),
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        sourceTxHash: hexField(event, "sourceTxHash"),
      });

    case "ProvisionalClearingDeclined":
      return row("ProvisionalClearingDeclined", {
        ...envelope,
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        sourceTxHash: hexField(event, "sourceTxHash"),
        freeBond: decimal(event, "freeBond"),
      });

    case "SettlementSuperseded":
      return row("SettlementSuperseded", {
        ...envelope,
        replayKey: hexField(event, "replayKey"),
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        observedDigest: hexField(event, "observedDigest"),
        attestedDigest: hexField(event, "attestedDigest"),
      });

    case "TabDelinquent":
      return row("TabDelinquent", {
        ...envelope,
        tabId: hexField(event, "tabId"),
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        unsettled: decimal(event, "unsettled"),
        windowEnd: safeNumber(event, "windowEnd"),
      });

    case "AddressBound":
      return row("AddressBound", {
        ...envelope,
        agent: hexField(event, "agent"),
        chainKey: safeNumber(event, "chainKey"),
        ethAddress: hexField(event, "ethAddress"),
        provingReplayKey: hexField(event, "provingReplayKey"),
      });

    case "RegistryChangeQueued": {
      const kind = integerField(event, "kind");
      return row("RegistryChangeQueued", {
        ...envelope,
        changeId: hexField(event, "changeId"),
        serviceId: hexField(event, "serviceId"),
        changeKind: Number(kind),
        changeKindName: enumMemberName("ChangeKind", kind),
        payload: hexField(event, "payload"),
        eta: safeNumber(event, "eta"),
      });
    }

    case "RegistryChangeApplied": {
      const kind = integerField(event, "kind");
      return row("RegistryChangeApplied", {
        ...envelope,
        changeId: hexField(event, "changeId"),
        serviceId: hexField(event, "serviceId"),
        changeKind: Number(kind),
        changeKindName: enumMemberName("ChangeKind", kind),
        payload: hexField(event, "payload"),
      });
    }

    case "RegistryChangeCancelled":
      return row("RegistryChangeCancelled", {
        ...envelope,
        changeId: hexField(event, "changeId"),
        serviceId: hexField(event, "serviceId"),
      });

    case "ServiceRegistered": {
      const tier = integerField(event, "tier");
      return row("ServiceRegistered", {
        ...envelope,
        serviceId: hexField(event, "serviceId"),
        operator: hexField(event, "operator"),
        tier: Number(tier),
        tierName: enumMemberName("Tier", tier),
        settlementWindow: safeNumber(event, "settlementWindow"),
      });
    }

    case "EmitterAuthorised": {
      const kind = integerField(event, "kind");
      return row("EmitterAuthorised", {
        ...envelope,
        chainKey: safeNumber(event, "chainKey"),
        emitter: hexField(event, "emitter"),
        emitterKind: Number(kind),
        emitterKindName: enumMemberName("EmitterKind", kind),
        asset: hexField(event, "asset"),
      });
    }

    case "CollectionRegistered": {
      const kind = integerField(event, "kind");
      return row("CollectionRegistered", {
        ...envelope,
        serviceId: hexField(event, "serviceId"),
        chainKey: safeNumber(event, "chainKey"),
        collection: hexField(event, "collection"),
        asset: hexField(event, "asset"),
        collectionKind: Number(kind),
        collectionKindName: enumMemberName("CollectionKind", kind),
      });
    }

    case "CollectionReleased":
      return row("CollectionReleased", {
        ...envelope,
        serviceId: hexField(event, "serviceId"),
        chainKey: safeNumber(event, "chainKey"),
        collection: hexField(event, "collection"),
      });

    case "ToolPriceSet":
      return row("ToolPriceSet", {
        ...envelope,
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        tool: hexField(event, "tool"),
        baseUnits: decimal(event, "baseUnits"),
      });

    case "HistoryExtended": {
      // The struct is flattened into eight `record_*` columns in declaration order,
      // which is also the order `TabBook._fold` hashes them in. Nothing is derived:
      // `curated` and `bonded` are the contract's snapshots at settlement time and
      // are stored as such, because they are what the commitment binds.
      const record = tupleField(event, "record");
      return row("HistoryExtended", {
        ...envelope,
        agent: hexField(event, "agent"),
        asset: hexField(event, "asset"),
        root: hexField(event, "root"),
        count: safeNumber(event, "count"),
        recordServiceId: hexField(record, "serviceId"),
        recordAsset: hexField(record, "asset"),
        recordAmount: decimal(record, "amount"),
        recordSettledAt: safeNumber(record, "settledAt"),
        recordFirstDeliveryAt: safeNumber(record, "firstDeliveryAt"),
        recordChainKey: safeNumber(record, "chainKey"),
        recordCurated: booleanField(record, "curated"),
        recordBonded: booleanField(record, "bonded"),
      });
    }

    case "AuthorisationSet":
      return row("AuthorisationSet", {
        ...envelope,
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        maxCumulative: decimal(event, "maxCumulative"),
        expiry: safeNumber(event, "expiry"),
      });

    case "PrepaidConsumed":
      return row("PrepaidConsumed", {
        ...envelope,
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        consumed: decimal(event, "consumed"),
        prepaidAfter: decimal(event, "prepaidAfter"),
        openAdded: decimal(event, "openAdded"),
      });

    case "BondFunded":
      return row("BondFunded", {
        ...envelope,
        party: hexField(event, "party"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        replayKey: hexField(event, "replayKey"),
      });

    case "BondReserved":
      return row("BondReserved", {
        ...envelope,
        clearingId: hexField(event, "clearingId"),
        party: hexField(event, "party"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
      });

    case "BondReleased":
      return row("BondReleased", {
        ...envelope,
        clearingId: hexField(event, "clearingId"),
        party: hexField(event, "party"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
      });

    case "SlashedForUnconfirmedClearing":
      return row("SlashedForUnconfirmedClearing", {
        ...envelope,
        clearingId: hexField(event, "clearingId"),
        party: hexField(event, "party"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        beneficiary: hexField(event, "beneficiary"),
      });

    case "SlashedForReorg":
      return row("SlashedForReorg", {
        ...envelope,
        replayKey: hexField(event, "replayKey"),
        party: hexField(event, "party"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        beneficiary: hexField(event, "beneficiary"),
      });

    case "ReorgSlashShortfall":
      return row("ReorgSlashShortfall", {
        ...envelope,
        replayKey: hexField(event, "replayKey"),
        party: hexField(event, "party"),
        asset: hexField(event, "asset"),
        requested: decimal(event, "requested"),
        slashed: decimal(event, "slashed"),
      });

    case "WithdrawalReleased":
      return row("WithdrawalReleased", {
        ...envelope,
        party: hexField(event, "party"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
      });
  }
}
