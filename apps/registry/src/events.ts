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
 * - `DeliveryRecorded`, `SettlementApplied`, `PrepaidConsumed`, `TabDelinquent`
 *   and `TabDelinquencyCleared` are the life of a tab: raised, paid down, spent
 *   from prepaid credit, declared late, and cleared.
 * - `Settled` is the same Settlement seen from the surface that moved the money,
 *   and carries the Collection address the Asset went to.
 * - `HistoryExtended` carries the committed `LimitLib.SettlementRecord` in full,
 *   which is the only way to rebuild the `LimitWitness` that `TabBook.creditLimit`
 *   answers against. `AuthorisationSet` travels with it: a spending authorisation
 *   makes a Service a counterparty before any Settlement exists, and
 *   `TabBook._resolveBonds` admits a Bond entry on exactly that basis.
 * - The `ServiceRegistry` directory events are what a queued change is a change
 *   *to*. The contract emits them so the directory is reconstructable from logs
 *   alone. `RegistryChangeCancelled` is what stops a withdrawn change from being
 *   served forever as pending with an ETA that will never arrive.
 * - `BondFunded` and `BondWithdrawn` are the escrow ledger in motion. The bond
 *   cap, the `bonded` filter, and free stake all rest on them.
 * - `Transfer`, `Registered`, `MetadataSet` and `URIUpdated` come from the
 *   ERC-8004 Identity registry rather than from Tab, and are declared in
 *   `erc8004.ts` against its vendored source. They are what an Agent's identity
 *   is folded from.
 *
 * ## What the decoder does not do
 *
 * It does not interpret. It records what the contract reported, under the
 * contract's own field names, with no collapsing and no derived state. Every
 * view is built downstream in `queries.ts`, where it can be tested against the
 * rows rather than against the chain.
 */
import { Indexed, Interface, type Log, type ParamType } from "ethers";

import { ERC8004_EVENT_DECLARATIONS, type Erc8004EventName } from "./erc8004.js";

/**
 * Which deployed contract a log has to come from to be recognised.
 *
 * The first four are Tab's own. `IdentityRegistry` is the canonical ERC-8004
 * Identity registry, watched so an Agent's on-chain identity can be served beside
 * its credit; see `erc8004.ts` for what it is and why.
 */
export const EVENT_SOURCES = ["TabBook", "TabSettlement", "ServiceRegistry", "Bond", "IdentityRegistry"] as const;

export type EventSource = (typeof EVENT_SOURCES)[number];

/** The contracts deployed from `packages/contracts`, whose addresses the configuration must carry. */
export type TabContract = Exclude<EventSource, "IdentityRegistry">;

/**
 * Every event the indexer reads, declared in the human-readable ABI form
 * `ethers` parses. Each declaration is checked against the compiled artefact
 * by `test/signatures.test.ts`, so a contract change cannot leave a stale
 * declaration here.
 */
export const EVENT_DECLARATIONS = {
  // ------------------------------------------------------------------ TabBook
  DeliveryRecorded:
    "event DeliveryRecorded(address indexed agent, bytes32 indexed serviceId, address indexed asset, bytes32 tool, uint32 units, uint256 amount, uint64 timestamp)",
  SettlementApplied:
    "event SettlementApplied(bytes32 indexed settlementId, address indexed agent, bytes32 indexed serviceId, address asset, uint256 applied, uint256 toPrepaid, uint128 openAfter)",
  HistoryExtended:
    "event HistoryExtended(address indexed agent, address indexed asset, bytes32 root, uint32 count, tuple(bytes32 serviceId, address asset, uint128 amount, uint64 settledAt, uint64 firstDeliveryAt, bool curated, bool bonded) record)",
  PrepaidConsumed:
    "event PrepaidConsumed(address indexed agent, bytes32 indexed serviceId, address indexed asset, uint128 consumed, uint128 prepaidAfter, uint128 openAdded)",
  TabDelinquent:
    "event TabDelinquent(bytes32 indexed tabId, address indexed agent, bytes32 indexed serviceId, address asset, uint128 unsettled, uint64 windowEnd)",
  TabDelinquencyCleared:
    "event TabDelinquencyCleared(bytes32 indexed tabId, address indexed agent, address indexed asset)",
  AuthorisationSet:
    "event AuthorisationSet(address indexed agent, bytes32 indexed serviceId, address indexed asset, uint128 maxCumulative, uint64 expiry)",
  CreditLimitZeroed:
    "event CreditLimitZeroed(address indexed agent, address indexed asset, bytes32 reasonTabId)",
  // ------------------------------------------------------------------ TabSettlement
  Settled:
    "event Settled(bytes32 indexed settlementId, address indexed agent, bytes32 indexed serviceId, address asset, uint128 amount, uint128 applied, uint128 toPrepaid, address collection)",
  // ------------------------------------------------------------------ ServiceRegistry
  ServiceRegistered:
    "event ServiceRegistered(bytes32 indexed serviceId, address indexed operator, uint8 tier, uint32 settlementWindow)",
  CollectionRegistered:
    "event CollectionRegistered(bytes32 indexed serviceId, address indexed asset, address indexed collection)",
  CollectionReleased:
    "event CollectionReleased(bytes32 indexed serviceId, address indexed asset, address indexed collection)",
  ToolPriceSet:
    "event ToolPriceSet(bytes32 indexed serviceId, address indexed asset, bytes32 indexed tool, uint256 baseUnits)",
  RegistryChangeQueued:
    "event RegistryChangeQueued(bytes32 indexed changeId, bytes32 indexed serviceId, uint8 kind, bytes payload, uint64 eta)",
  RegistryChangeApplied:
    "event RegistryChangeApplied(bytes32 indexed changeId, bytes32 indexed serviceId, uint8 kind, bytes payload)",
  RegistryChangeCancelled:
    "event RegistryChangeCancelled(bytes32 indexed changeId, bytes32 indexed serviceId)",
  // ------------------------------------------------------------------ Bond
  BondFunded:
    "event BondFunded(bytes32 indexed party, address indexed asset, uint128 amount, address depositor)",
  BondWithdrawn:
    "event BondWithdrawn(bytes32 indexed party, address indexed asset, uint128 amount, address to)",
  // ------------------------------------------------------------------ IdentityRegistry (ERC-8004)
  ...ERC8004_EVENT_DECLARATIONS,
} as const;

export type IndexedEventName = keyof typeof EVENT_DECLARATIONS;

/** The Tab events alone, which is what the contract-source check covers from `packages/contracts`. */
export type TabEventName = Exclude<IndexedEventName, Erc8004EventName>;

/** Which contract emits each event, so the indexer filters each address for the right topics. */
export const EVENT_OWNER: Readonly<Record<IndexedEventName, EventSource>> = {
  DeliveryRecorded: "TabBook",
  SettlementApplied: "TabBook",
  HistoryExtended: "TabBook",
  PrepaidConsumed: "TabBook",
  TabDelinquent: "TabBook",
  TabDelinquencyCleared: "TabBook",
  AuthorisationSet: "TabBook",
  CreditLimitZeroed: "TabBook",
  Settled: "TabSettlement",
  ServiceRegistered: "ServiceRegistry",
  CollectionRegistered: "ServiceRegistry",
  CollectionReleased: "ServiceRegistry",
  ToolPriceSet: "ServiceRegistry",
  RegistryChangeQueued: "ServiceRegistry",
  RegistryChangeApplied: "ServiceRegistry",
  RegistryChangeCancelled: "ServiceRegistry",
  BondFunded: "Bond",
  BondWithdrawn: "Bond",
  Transfer: "IdentityRegistry",
  Registered: "IdentityRegistry",
  MetadataSet: "IdentityRegistry",
  URIUpdated: "IdentityRegistry",
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
 * A `null` is not an error and is never a reason to stop: the five watched
 * contracts emit events beyond this surface, such as `SettlementSurfaceWired`,
 * `SettledGasless`, and the Identity registry's approvals, and a log the filter
 * let through but this file does not name is skipped and counted, never dropped
 * silently and never fatal.
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
 * a `string` kept exactly as emitted for a `string`, and a nested record for a
 * struct, each component normalised the same way.
 *
 * An indexed `string` or `bytes` never reaches a log as its value: Solidity puts
 * its keccak-256 hash in the topic, and `ethers` surfaces that as an `Indexed`
 * marker carrying the hash. The hash is what is stored, as lowercase hex, because
 * it is all the chain kept.
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
  if (value instanceof Indexed) {
    if (value.hash === null) {
      throw new Error(`events: ${event}.${field} is indexed ${type} but its topic hash is missing`);
    }
    return hex(value.hash);
  }
  if (type === "string") {
    if (typeof value !== "string") {
      throw new Error(`events: ${event}.${field} declared string decoded as ${typeof value}`);
    }
    return value;
  }
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

/**
 * A decoded `string` field, as emitted. Distinct from {@link hexField} because a
 * URI is not hex and is never lowercased.
 */
export function stringField(event: DecodedEvent, field: string): string {
  const value = event.fields[field];
  if (typeof value !== "string") {
    throw new Error(`events: ${event.name}.${field} is not a string field`);
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
