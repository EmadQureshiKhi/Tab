/**
 * The event surface this service indexes, and the pure decoder over it.
 *
 * Every signature below was read out of `packages/contracts/src/*.sol`, which is
 * the only authority for them: the contracts are deployed and emitting, so a
 * signature that disagrees with the source is a signature that matches no log on
 * chain. `test/signatures.test.ts` re-reads those `.sol` files and fails when any
 * signature here drifts from the declaration it claims to mirror, so this file
 * cannot quietly fall behind the contracts.
 *
 * ## Why these events
 *
 * Task 18.1 names seven: `SettlementRecorded`, `SettlementApplied`,
 * `ProvisionalClearing*`, `TabDelinquent`, `AddressBound`,
 * `RegistryChangeQueued`, and `RegistryChangeApplied`. Three additions carry
 * their weight:
 *
 * - `SettlementSuperseded` is the only event that reports the fifth clearing
 *   state. Without it a reader can see a clearing reach `Confirmed` and never
 *   learn that a Source Chain reorganisation took it away.
 * - `RegistryChangeCancelled` is what stops a withdrawn change from being served
 *   forever as pending with an ETA that will never arrive.
 * - The `ServiceRegistry` directory events — `ServiceRegistered`,
 *   `EmitterAuthorised`, `CollectionRegistered`, `CollectionReleased`, and
 *   `ToolPriceSet` — are what a queued change is a change *to*. The contract
 *   emits them precisely so the emitter and collection tables are reconstructable
 *   from logs alone, and the Service directory read of task 18.2 has nothing to
 *   list without them.
 * - `HistoryExtended` carries the committed `LimitLib.SettlementRecord` in full,
 *   which is the only way to rebuild the `LimitWitness` that `TabBook.creditLimit`
 *   answers against. Without it no Credit Limit can be served, because the four
 *   snapshot fields the contract authors at settlement time are recoverable from
 *   nothing else. `AuthorisationSet` travels with it: a spending authorisation
 *   makes a Service a counterparty before any Settlement exists, and
 *   `TabBook._resolveBonds` admits a Bond entry on exactly that basis.
 * - The `Bond` ledger events - `BondFunded`, `BondReserved`, `BondReleased`,
 *   `SlashedForUnconfirmedClearing`, `SlashedForReorg`, `ReorgSlashShortfall`,
 *   and `WithdrawalReleased` - are the four stored ledger figures in motion. The
 *   bond cap, the `bonded` filter, and free Bond all rest on them, and none is
 *   derivable from a Settlement alone.
 *
 * ## What the decoder does not do
 *
 * It does not interpret. A clearing has five states and this file records the one
 * the contract reported, under the contract's own field names, with no collapsing
 * and no renaming. The single vocabulary difference in the whole service — the
 * contract-side `Applied` against the Dashboard's `Provisional` — lives in
 * `clearing.ts` and agrees with `apps/app/components/custom-ui/clearing-state.ts`
 * rather than inventing a second table.
 *
 * Requirements: 12.6, 24.4
 */

import { Interface, type Log, type ParamType } from "ethers";

/** Which deployed contract a log has to come from to be recognised. */
export const EVENT_SOURCES = [
  "SettlementVerifier",
  "TabBook",
  "AgentRegistry",
  "ServiceRegistry",
  "Bond",
] as const;

export type EventSource = (typeof EVENT_SOURCES)[number];

/**
 * Canonical declarations, in Solidity form, exactly as the sources declare them.
 * `indexed` is retained because the decoder needs it to split topics from data;
 * the topic hash is taken over the signature with the keyword and the parameter
 * names removed, which `ethers` does itself.
 */
export const EVENT_DECLARATIONS = {
  SettlementRecorded:
    "event SettlementRecorded(bytes32 indexed replayKey, uint64 chainKey, uint64 blockHeight, uint64 txIndex, uint64 logIndex, address indexed agent, bytes32 indexed serviceId, address asset, uint256 amount, address payerAddress, bytes32 sourceTabId)",
  // The Bond branch's counterpart to `SettlementRecorded`, and the reason both are
  // indexed. `SettlementVerifier._credit` routes a Settlement that names a Bond
  // Collection Address to `Bond.fundFromVerifiedSettlement` and emits this instead;
  // it does **not** emit `SettlementRecorded` on that path. It is the only event that
  // carries the Bond `party` beside the `serviceId`, so it is what maps a ledger to
  // the Service that owns it without reading the registry.
  BondDepositRecorded:
    "event BondDepositRecorded(bytes32 indexed replayKey, uint64 chainKey, uint64 blockHeight, uint64 txIndex, uint64 logIndex, address indexed depositor, bytes32 indexed serviceId, address asset, uint256 amount, address payerAddress, bytes32 party)",
  SettlementApplied:
    "event SettlementApplied(bytes32 indexed replayKey, address indexed agent, bytes32 indexed serviceId, address asset, uint256 applied, uint256 toPrepaid, uint128 openAfter)",
  ProvisionalClearingApplied:
    "event ProvisionalClearingApplied(bytes32 indexed clearingId, address indexed agent, bytes32 indexed serviceId, address asset, uint128 amount, bytes32 sourceTxHash, uint64 deadline)",
  ProvisionalClearingConfirmed:
    "event ProvisionalClearingConfirmed(bytes32 indexed clearingId, address indexed agent, bytes32 indexed serviceId, address asset, uint128 amount, bytes32 sourceTxHash)",
  ProvisionalClearingReversed:
    "event ProvisionalClearingReversed(bytes32 indexed clearingId, address indexed agent, bytes32 indexed serviceId, address asset, uint128 amount, bytes32 sourceTxHash)",
  ProvisionalClearingDeclined:
    "event ProvisionalClearingDeclined(address indexed agent, bytes32 indexed serviceId, address asset, uint128 amount, bytes32 sourceTxHash, uint128 freeBond)",
  SettlementSuperseded:
    "event SettlementSuperseded(bytes32 indexed replayKey, address indexed agent, bytes32 indexed serviceId, address asset, uint128 amount, bytes32 observedDigest, bytes32 attestedDigest)",
  TabDelinquent:
    "event TabDelinquent(bytes32 indexed tabId, address indexed agent, bytes32 indexed serviceId, address asset, uint128 unsettled, uint64 windowEnd)",
  AddressBound:
    "event AddressBound(address indexed agent, uint64 chainKey, address indexed ethAddress, bytes32 provingReplayKey)",
  RegistryChangeQueued:
    "event RegistryChangeQueued(bytes32 indexed changeId, bytes32 indexed serviceId, uint8 kind, bytes payload, uint64 eta)",
  RegistryChangeApplied:
    "event RegistryChangeApplied(bytes32 indexed changeId, bytes32 indexed serviceId, uint8 kind, bytes payload)",
  RegistryChangeCancelled:
    "event RegistryChangeCancelled(bytes32 indexed changeId, bytes32 indexed serviceId)",
  ServiceRegistered:
    "event ServiceRegistered(bytes32 indexed serviceId, address indexed operator, uint8 tier, uint32 settlementWindow)",
  EmitterAuthorised:
    "event EmitterAuthorised(uint64 indexed chainKey, address indexed emitter, uint8 kind, address asset)",
  CollectionRegistered:
    "event CollectionRegistered(bytes32 indexed serviceId, uint64 indexed chainKey, address indexed collection, address asset, uint8 kind)",
  CollectionReleased:
    "event CollectionReleased(bytes32 indexed serviceId, uint64 indexed chainKey, address indexed collection)",
  ToolPriceSet:
    "event ToolPriceSet(bytes32 indexed serviceId, address indexed asset, bytes32 indexed tool, uint256 baseUnits)",
  // `record` is `LimitLib.SettlementRecord`, spelled as the tuple it is on the wire.
  // The field order is the struct's declaration order and is what `_fold` hashes.
  HistoryExtended:
    "event HistoryExtended(address indexed agent, address indexed asset, bytes32 root, uint32 count, tuple(bytes32 serviceId, address asset, uint128 amount, uint64 settledAt, uint64 firstDeliveryAt, uint64 chainKey, bool curated, bool bonded) record)",
  AuthorisationSet:
    "event AuthorisationSet(address indexed agent, bytes32 indexed serviceId, address indexed asset, uint128 maxCumulative, uint64 expiry)",
  PrepaidConsumed:
    "event PrepaidConsumed(address indexed agent, bytes32 indexed serviceId, address indexed asset, uint128 consumed, uint128 prepaidAfter, uint128 openAdded)",
  BondFunded:
    "event BondFunded(bytes32 indexed party, address indexed asset, uint128 amount, bytes32 replayKey)",
  BondReserved:
    "event BondReserved(bytes32 indexed clearingId, bytes32 indexed party, address indexed asset, uint128 amount)",
  BondReleased:
    "event BondReleased(bytes32 indexed clearingId, bytes32 indexed party, address indexed asset, uint128 amount)",
  SlashedForUnconfirmedClearing:
    "event SlashedForUnconfirmedClearing(bytes32 indexed clearingId, bytes32 indexed party, address indexed asset, uint128 amount, address beneficiary)",
  SlashedForReorg:
    "event SlashedForReorg(bytes32 indexed replayKey, bytes32 indexed party, address indexed asset, uint128 amount, address beneficiary)",
  ReorgSlashShortfall:
    "event ReorgSlashShortfall(bytes32 indexed replayKey, bytes32 indexed party, address indexed asset, uint128 requested, uint128 slashed)",
  WithdrawalReleased:
    "event WithdrawalReleased(bytes32 indexed party, address indexed asset, uint128 amount)",
} as const;

export type IndexedEventName = keyof typeof EVENT_DECLARATIONS;

/**
 * Which contract each event comes from.
 *
 * The enumerated types in the three registry events are declared as their
 * Solidity enumeration on the contract — `ChangeKind`, `EmitterKind`,
 * `CollectionKind`, `Tier` — and an enumeration is `uint8` on the wire, so the
 * declarations above spell `uint8` and `enum-name.ts` names the members. The
 * topic hash is identical either way, which is what makes the substitution safe.
 */
export const EVENT_OWNER: Readonly<Record<IndexedEventName, EventSource>> = {
  SettlementRecorded: "SettlementVerifier",
  BondDepositRecorded: "SettlementVerifier",
  SettlementApplied: "TabBook",
  ProvisionalClearingApplied: "TabBook",
  ProvisionalClearingConfirmed: "TabBook",
  ProvisionalClearingReversed: "TabBook",
  ProvisionalClearingDeclined: "TabBook",
  SettlementSuperseded: "TabBook",
  TabDelinquent: "TabBook",
  AddressBound: "AgentRegistry",
  RegistryChangeQueued: "ServiceRegistry",
  RegistryChangeApplied: "ServiceRegistry",
  RegistryChangeCancelled: "ServiceRegistry",
  ServiceRegistered: "ServiceRegistry",
  EmitterAuthorised: "ServiceRegistry",
  CollectionRegistered: "ServiceRegistry",
  CollectionReleased: "ServiceRegistry",
  ToolPriceSet: "ServiceRegistry",
  HistoryExtended: "TabBook",
  AuthorisationSet: "TabBook",
  PrepaidConsumed: "TabBook",
  BondFunded: "Bond",
  BondReserved: "Bond",
  BondReleased: "Bond",
  SlashedForUnconfirmedClearing: "Bond",
  SlashedForReorg: "Bond",
  ReorgSlashShortfall: "Bond",
  WithdrawalReleased: "Bond",
};

export const INDEXED_EVENT_NAMES = Object.keys(EVENT_DECLARATIONS) as readonly IndexedEventName[];

/** One `Interface` over the whole surface, so one `parseLog` handles every log. */
export const REGISTRY_INTERFACE = new Interface(Object.values(EVENT_DECLARATIONS));

/** `topics[0]` per event, derived by `ethers` from the declaration rather than transcribed. */
export const EVENT_TOPIC0: Readonly<Record<IndexedEventName, string>> = Object.fromEntries(
  INDEXED_EVENT_NAMES.map((name) => {
    const fragment = REGISTRY_INTERFACE.getEvent(name);
    if (fragment === null) throw new Error(`events: no fragment for ${name}`);
    return [name, fragment.topicHash.toLowerCase()];
  }),
) as Record<IndexedEventName, string>;

/** The reverse map, which is what the log filter's `topics[0]` set is matched through. */
export const EVENT_BY_TOPIC0: ReadonlyMap<string, IndexedEventName> = new Map(
  INDEXED_EVENT_NAMES.map((name) => [EVENT_TOPIC0[name], name]),
);

/** Every `topics[0]` the filter asks for, which is what keeps unrelated logs off the wire. */
export const ALL_TOPIC0: readonly string[] = INDEXED_EVENT_NAMES.map((name) => EVENT_TOPIC0[name]);

// ------------------------------------------------------------------ log shapes

/**
 * The envelope of one log, independent of which event it carries.
 *
 * `blockHash` and `logIndex` together are the row identity. `logIndex` is unique
 * within a block and `blockHash` identifies the block, so the pair is unique
 * across the chain *and* stays distinct across a reorganisation: a re-mined block
 * carrying the same logs has a different hash, so its rows cannot silently
 * overwrite the abandoned branch's rows. That is the whole basis of the
 * idempotence in `indexer.ts`.
 */
export interface LogEnvelope {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly txHash: string;
  readonly txIndex: number;
  readonly logIndex: number;
  readonly emitter: string;
  readonly topic0: string;
}

/**
 * One decoded value. `bigint` for every integer width, lowercase `0x` hex for
 * every address, `bytes32`, and `bytes`, a `boolean` for `bool`, and a nested
 * record for a struct, keyed by the struct's own field names.
 */
export type FieldValue = bigint | string | boolean | { readonly [field: string]: FieldValue };

/** A decoded log: its envelope, its event name, and its fields by name. */
export interface DecodedEvent {
  readonly envelope: LogEnvelope;
  readonly name: IndexedEventName;
  /** Field values keyed by the contract's own parameter name, in declaration order. */
  readonly fields: Readonly<Record<string, FieldValue>>;
}

/** Raw hex normalisation: one casing everywhere, so equality is string equality. */
export const hex = (value: string): string => value.toLowerCase();

/** The subset of an `ethers` log this service reads. Kept structural so tests need no provider. */
export interface RawLog {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly transactionIndex: number;
  readonly index: number;
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** Narrows an `ethers` log to the structural shape above. */
export const toRawLog = (log: Log): RawLog => ({
  blockNumber: log.blockNumber,
  blockHash: log.blockHash,
  transactionHash: log.transactionHash,
  transactionIndex: log.transactionIndex,
  index: log.index,
  address: log.address,
  topics: log.topics,
  data: log.data,
});

export const envelopeOf = (log: RawLog): LogEnvelope => ({
  blockNumber: log.blockNumber,
  blockHash: hex(log.blockHash),
  txHash: hex(log.transactionHash),
  txIndex: log.transactionIndex,
  logIndex: log.index,
  emitter: hex(log.address),
  topic0: hex(log.topics[0] ?? ""),
});

/**
 * Decodes one log, or returns `null` when its `topics[0]` is not one this service
 * indexes.
 *
 * A `null` is not an error and is never a reason to stop: the five contracts emit
 * events beyond this surface — wiring events, `DeliveryRecorded`,
 * `TabDelinquencyCleared`, `CreditLimitZeroed` - and a log the filter let through
 * but this file does not name is skipped and counted, never dropped silently and
 * never fatal. The same rule the ingestion core follows on chain.
 *
 * @throws Error when a recognised `topics[0]` fails to decode, which means the
 * declaration here and the contract have diverged and every later row would be
 * wrong. That is worth stopping for.
 */
export function decodeLog(log: RawLog): DecodedEvent | null {
  const topic0 = hex(log.topics[0] ?? "");
  const name = EVENT_BY_TOPIC0.get(topic0);
  if (name === undefined) return null;

  const fragment = REGISTRY_INTERFACE.getEvent(name);
  if (fragment === null) throw new Error(`events: no fragment for ${name}`);

  const decoded = REGISTRY_INTERFACE.decodeEventLog(fragment, log.data, [...log.topics]);
  const fields: Record<string, FieldValue> = {};
  fragment.inputs.forEach((input, position) => {
    const value = decoded[position] as unknown;
    fields[input.name] = normaliseField(input, value, name, input.name);
  });

  return { envelope: envelopeOf(log), name, fields };
}

/**
 * One value, normalised to the shapes the whole service carries: `bigint` for an
 * integer, lowercase `0x` hex for anything byte-shaped, a `boolean` for a flag,
 * and a nested record for a struct, each component normalised the same way.
 *
 * @throws Error naming the event, the field, and the type when a value arrives in
 * a shape this function does not expect. Silently coercing here would put a
 * wrong number in a settled amount, so it refuses instead.
 */
function normaliseField(
  input: ParamType,
  value: unknown,
  event: string,
  field: string,
): FieldValue {
  const type = input.type;
  if (input.baseType === "tuple") {
    // A struct decodes as an array-like `Result` in component order. The
    // components carry the contract's own field names, so the record is keyed on
    // them rather than on positions, and every component goes through this same
    // function so a `uint128` inside a struct is a `bigint` like one outside it.
    const components = input.components ?? [];
    if (!Array.isArray(value) || value.length !== components.length) {
      throw new Error(`events: ${event}.${field} declared ${type} decoded as ${typeof value}`);
    }
    const record: Record<string, FieldValue> = {};
    components.forEach((component, position) => {
      record[component.name] = normaliseField(
        component,
        value[position] as unknown,
        event,
        `${field}.${component.name}`,
      );
    });
    return record;
  }
  if (type === "bool") {
    if (typeof value !== "boolean") {
      throw new Error(`events: ${event}.${field} declared bool decoded as ${typeof value}`);
    }
    return value;
  }
  if (type === "address" || type.startsWith("bytes")) {
    if (typeof value !== "string") {
      throw new Error(`events: ${event}.${field} declared ${type} decoded as ${typeof value}`);
    }
    return hex(value);
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    throw new Error(`events: ${event}.${field} declared ${type} decoded as ${typeof value}`);
  }
  throw new Error(`events: ${event}.${field} carries unsupported type ${type}`);
}

/** A decoded integer field, or a failure naming what was missing. */
export function integerField(event: DecodedEvent, field: string): bigint {
  const value = event.fields[field];
  if (typeof value !== "bigint") {
    throw new Error(`events: ${event.name}.${field} is not an integer field`);
  }
  return value;
}

/** A decoded hex field, or a failure naming what was missing. */
export function hexField(event: DecodedEvent, field: string): string {
  const value = event.fields[field];
  if (typeof value !== "string") {
    throw new Error(`events: ${event.name}.${field} is not a hex field`);
  }
  return value;
}

/** A decoded `bool` field, or a failure naming what was missing. */
export function booleanField(event: DecodedEvent, field: string): boolean {
  const value = event.fields[field];
  if (typeof value !== "boolean") {
    throw new Error(`events: ${event.name}.${field} is not a boolean field`);
  }
  return value;
}

/**
 * A decoded struct field as a nested {@link DecodedEvent}, so the same readers
 * work one level down: `hexField(tupleField(event, "record"), "serviceId")`.
 */
export function tupleField(event: DecodedEvent, field: string): DecodedEvent {
  const value = event.fields[field];
  if (typeof value !== "object" || value === null) {
    throw new Error(`events: ${event.name}.${field} is not a struct field`);
  }
  return { envelope: event.envelope, name: event.name, fields: value };
}
