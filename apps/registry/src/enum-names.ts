/**
 * The four Solidity enumerations that reach this service through an event, and
 * their member names.
 *
 * An enumeration is a `uint8` on the wire, so an indexer that stored the number
 * alone would be storing a fact nobody can read without the contract source next
 * to them. Every table therefore carries both: the number the contract emitted,
 * which is the fact, and the member name, which is what makes it legible. The
 * number is authoritative; the name is derived from it here and nowhere else.
 *
 * Member order is the declaration order in `packages/contracts/src/ServiceRegistry.sol`.
 * `test/signatures.test.ts` re-reads that source and fails when a member is added,
 * removed, or reordered, because a reordered enumeration would silently relabel
 * every historical row.
 *
 * Requirements: 12.6, 24.4
 */

/** `ServiceRegistry.ChangeKind` — which registry fact a timelocked change rewrites. */
export const CHANGE_KINDS = ["Tier", "Price", "Collection", "AcceptedAsset", "SettlementWindow"] as const;

/** `ServiceRegistry.EmitterKind` — which Settlement signature an emitter may produce. */
export const EMITTER_KINDS = ["None", "Asset", "SettlementContract"] as const;

/** `ServiceRegistry.CollectionKind` — whether a Collection Address collects for a tab or a Bond. */
export const COLLECTION_KINDS = ["Tab", "Bond"] as const;

/** `ServiceRegistry.Tier` — the curation tier, which gates Credit Limit weight and nothing else. */
export const TIERS = ["Permissionless", "Curated"] as const;

/** Every enumeration this service decodes, keyed by its Solidity name. */
export const SOLIDITY_ENUMS = {
  ChangeKind: CHANGE_KINDS,
  EmitterKind: EMITTER_KINDS,
  CollectionKind: COLLECTION_KINDS,
  Tier: TIERS,
} as const;

export type SolidityEnumName = keyof typeof SOLIDITY_ENUMS;

/**
 * The member name for a value, or `"unknown(<n>)"` when the chain reports a member
 * this build does not know.
 *
 * It does not throw. A contract upgrade that appends a member must not stop the
 * indexer: the number is stored either way, so an unknown name costs legibility
 * for one row and nothing else, whereas a throw would stall the whole stream
 * behind a single log.
 */
export function enumMemberName(enumName: SolidityEnumName, value: bigint | number): string {
  const members: readonly string[] = SOLIDITY_ENUMS[enumName];
  const position = Number(value);
  if (!Number.isInteger(position) || position < 0 || position >= members.length) {
    return `unknown(${value})`;
  }
  return members[position] ?? `unknown(${value})`;
}

/** True when the chain reported a member this build knows. */
export const isKnownEnumMember = (enumName: SolidityEnumName, value: bigint | number): boolean =>
  !enumMemberName(enumName, value).startsWith("unknown(");
