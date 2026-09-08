/**
 * Decoded event to database row. The only place a chain fact is shaped for storage.
 *
 * Two rules hold throughout, and both are about not losing information:
 *
 * **Nothing is reinterpreted.** Each event maps to one row in its own table under
 * the contract's own field names. No event is folded into another. What the read
 * layer makes of the rows is the read layer's business; this module records what
 * the chain said.
 *
 * **Nothing is narrowed silently.** A `uint256` becomes a decimal string for a
 * `numeric` column, never a float. A `uint64` becomes a JavaScript number only
 * after {@link safeNumber} has checked it against the safe-integer ceiling, so a
 * value that could not survive the conversion stops the row rather than landing
 * rounded.
 */
import { enumMemberName } from "./enum-names.js";
import {
  booleanField,
  hexField,
  integerField,
  stringField,
  tupleField,
  type DecodedEvent,
  type IndexedEventName,
} from "./events.js";
import { TYPED_TABLES } from "./schema.js";

export interface TypedInsert {
  readonly event: IndexedEventName;
  readonly values: Readonly<Record<string, unknown>>;
}

const row = <N extends IndexedEventName>(
  event: N,
  values: (typeof TYPED_TABLES)[N]["$inferInsert"],
): TypedInsert => ({ event, values: values as Record<string, unknown> });

export function safeNumber(event: DecodedEvent, field: string): number {
  const value = integerField(event, field);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `rows: ${event.name}.${field} is ${value}, beyond the safe-integer range, so it cannot be stored without rounding`,
    );
  }
  return Number(value);
}

const decimal = (event: DecodedEvent, field: string): string => integerField(event, field).toString();

export function toTypedInsert(event: DecodedEvent): TypedInsert {
  const envelope = { blockHash: event.envelope.blockHash, logIndex: event.envelope.logIndex };
  switch (event.name) {
    case "DeliveryRecorded":
      return row("DeliveryRecorded", {
        ...envelope,
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        tool: hexField(event, "tool"),
        units: safeNumber(event, "units"),
        amount: decimal(event, "amount"),
        timestamp: safeNumber(event, "timestamp"),
      });
    case "SettlementApplied":
      return row("SettlementApplied", {
        ...envelope,
        settlementId: hexField(event, "settlementId"),
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        applied: decimal(event, "applied"),
        toPrepaid: decimal(event, "toPrepaid"),
        openAfter: decimal(event, "openAfter"),
      });
    case "HistoryExtended": {
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
        recordCurated: booleanField(record, "curated"),
        recordBonded: booleanField(record, "bonded"),
      });
    }
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
    case "TabDelinquencyCleared":
      return row("TabDelinquencyCleared", {
        ...envelope,
        tabId: hexField(event, "tabId"),
        agent: hexField(event, "agent"),
        asset: hexField(event, "asset"),
      });
    case "AuthorisationSet":
      return row("AuthorisationSet", {
        ...envelope,
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        maxCumulative: decimal(event, "maxCumulative"),
        expiry: safeNumber(event, "expiry"),
      });
    case "CreditLimitZeroed":
      return row("CreditLimitZeroed", {
        ...envelope,
        agent: hexField(event, "agent"),
        asset: hexField(event, "asset"),
        reasonTabId: hexField(event, "reasonTabId"),
      });
    case "Settled":
      return row("Settled", {
        ...envelope,
        settlementId: hexField(event, "settlementId"),
        agent: hexField(event, "agent"),
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        applied: decimal(event, "applied"),
        toPrepaid: decimal(event, "toPrepaid"),
        collection: hexField(event, "collection"),
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
    case "CollectionRegistered":
      return row("CollectionRegistered", {
        ...envelope,
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
        collection: hexField(event, "collection"),
      });
    case "CollectionReleased":
      return row("CollectionReleased", {
        ...envelope,
        serviceId: hexField(event, "serviceId"),
        asset: hexField(event, "asset"),
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
    case "BondFunded":
      return row("BondFunded", {
        ...envelope,
        party: hexField(event, "party"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        depositor: hexField(event, "depositor"),
      });
    case "BondWithdrawn":
      return row("BondWithdrawn", {
        ...envelope,
        party: hexField(event, "party"),
        asset: hexField(event, "asset"),
        amount: decimal(event, "amount"),
        recipient: hexField(event, "to"),
      });
    // ---------------------------------------------------------- IdentityRegistry (ERC-8004)
    // The agent id is a uint256 token id and is stored at its full width as a
    // decimal string, like every other integer the chain could make large.
    case "Transfer":
      return row("Transfer", {
        ...envelope,
        sender: hexField(event, "from"),
        recipient: hexField(event, "to"),
        agentId: decimal(event, "tokenId"),
      });
    case "Registered":
      return row("Registered", {
        ...envelope,
        agentId: decimal(event, "agentId"),
        agentUri: stringField(event, "agentURI"),
        owner: hexField(event, "owner"),
      });
    case "MetadataSet":
      return row("MetadataSet", {
        ...envelope,
        agentId: decimal(event, "agentId"),
        metadataKeyHash: hexField(event, "indexedMetadataKey"),
        metadataKey: stringField(event, "metadataKey"),
        metadataValue: hexField(event, "metadataValue"),
      });
    case "URIUpdated":
      return row("URIUpdated", {
        ...envelope,
        agentId: decimal(event, "agentId"),
        newUri: stringField(event, "newURI"),
        updatedBy: hexField(event, "updatedBy"),
      });
  }
}
