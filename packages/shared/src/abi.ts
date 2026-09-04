/**
 * Contract interface constants shared by the SDK, the gateway, the registry
 * indexer, and the dashboard.
 *
 * Only what is fixed and independently checkable lives here: canonical event
 * signatures and the topic hashes derived from them. Full ABI arrays come from
 * the Foundry artefacts in `packages/contracts/out`, never from a hand
 * transcription, so there is one source of truth for every selector.
 */
import { keccak256Ascii } from "./keccak256.js";
import type { Bytes32 } from "./hex.js";

/**
 * Canonical event signatures, the exact strings the topic hash is taken over.
 * No spaces, no parameter names, canonical types.
 */
export const EVENT_SIGNATURES = {
  /** `TabBook.SettlementApplied`: a Settlement lowered an Open Tab. `topics[1]` is the settlement id. */
  SettlementApplied: "SettlementApplied(bytes32,address,bytes32,address,uint256,uint256,uint128)",
  /** `TabBook.DeliveryRecorded`: a Service metered usage into an Open Tab. `topics[1]` is the Agent. */
  DeliveryRecorded: "DeliveryRecorded(address,bytes32,address,bytes32,uint32,uint256,uint64)",
  /** `TabBook.HistoryExtended`: the Agent's history commitment advanced by one record. */
  HistoryExtended:
    "HistoryExtended(address,address,bytes32,uint32,(bytes32,address,uint128,uint64,uint64,bool,bool))",
  /** `TabBook.TabDelinquent`: a Settlement Window closed with the tab still open. */
  TabDelinquent: "TabDelinquent(bytes32,address,bytes32,address,uint128,uint64)",
  /** `TabBook.TabDelinquencyCleared`: the delinquent tab settled to zero. */
  TabDelinquencyCleared: "TabDelinquencyCleared(bytes32,address,address)",
  /** `TabSettlement.Settled`: the Asset moved from the Agent to the Service's Collection address. */
  Settled: "Settled(bytes32,address,bytes32,address,uint128,uint128,uint128,address)",
  /**
   * `TabSettlement.SettledGasless`: the Settlement arrived on the Agent's Permit2 signature and
   * `topics[2]` is the relayer that paid for it. Always follows a `Settled` with the same id.
   */
  SettledGasless: "SettledGasless(bytes32,address)",
  /** `Bond.BondFunded`: stake entered the escrow. */
  BondFunded: "BondFunded(bytes32,address,uint128,address)",
  /** `Bond.BondWithdrawn`: stake left the escrow. */
  BondWithdrawn: "BondWithdrawn(bytes32,address,uint128,address)",
  /** ERC-20 `Transfer`, for reading balances and payouts off the Asset contract. */
  Transfer: "Transfer(address,address,uint256)",
} as const;

/** Name of an event whose signature this module pins. */
export type EventName = keyof typeof EVENT_SIGNATURES;

/**
 * `topics[0]` for each pinned event: the Keccak-256 hash of its canonical
 * signature. Derived rather than transcribed, so a signature edit cannot leave a
 * stale hash behind.
 */
export const EVENT_TOPIC0: Readonly<Record<EventName, Bytes32>> = Object.fromEntries(
  Object.entries(EVENT_SIGNATURES).map(([name, signature]) => [name, keccak256Ascii(signature)]),
) as Record<EventName, Bytes32>;

/** `topics[0]` for a pinned event. */
export const eventTopic0 = (name: EventName): Bytes32 => EVENT_TOPIC0[name];

// ---------------------------------------------------------------------------
// Gasless Settlement through Permit2
//
// `TabSettlement.settleWithPermit2` verifies an EIP-712 signature the Agent
// made under Permit2's domain, over Permit2's `PermitWitnessTransferFrom` with
// a Tab-specific witness. Everything a signer needs is pinned here so the SDK
// cannot drift from the contract: the witness type, the string the contract
// hands Permit2, and the typed-data layout for `signTypedData`.
// ---------------------------------------------------------------------------

/**
 * The witness struct, exactly as `TabSettlement.WITNESS_TYPE` declares it.
 * `surface` is the `TabSettlement` address and `chainId` the chain it lives on.
 */
export const TAB_SETTLEMENT_WITNESS_TYPE =
  "TabSettlement(bytes32 serviceId,address asset,uint128 amount,address surface,uint256 chainId)" as const;

/** `keccak256(TAB_SETTLEMENT_WITNESS_TYPE)`, the same value as `TabSettlement.WITNESS_TYPEHASH`. */
export const TAB_SETTLEMENT_WITNESS_TYPEHASH: Bytes32 = keccak256Ascii(TAB_SETTLEMENT_WITNESS_TYPE);

/**
 * What the contract passes Permit2 as `witnessTypeString`, exactly as
 * `TabSettlement.WITNESS_TYPE_STRING` declares it. Permit2 appends it to
 * `PERMIT2_WITNESS_TRANSFER_FROM_STUB`.
 */
export const PERMIT2_WITNESS_TYPE_STRING =
  `TabSettlement witness)${TAB_SETTLEMENT_WITNESS_TYPE}TokenPermissions(address token,uint256 amount)` as const;

/** Permit2's own `_PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB`. */
export const PERMIT2_WITNESS_TRANSFER_FROM_STUB =
  "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline," as const;

/** The full primary type Permit2 hashes, and its typehash. */
export const PERMIT2_WITNESS_TRANSFER_FROM_TYPE =
  `${PERMIT2_WITNESS_TRANSFER_FROM_STUB}${PERMIT2_WITNESS_TYPE_STRING}` as const;
export const PERMIT2_WITNESS_TRANSFER_FROM_TYPEHASH: Bytes32 = keccak256Ascii(
  PERMIT2_WITNESS_TRANSFER_FROM_TYPE,
);

/** Permit2's EIP-712 domain name. Its domain has no `version`. */
export const PERMIT2_DOMAIN_NAME = "Permit2" as const;

/**
 * The EIP-712 domain an Agent signs a gasless Settlement under: Permit2's, on
 * the chain the Settlement happens on.
 */
export function permit2Domain(chainId: number | bigint, permit2: `0x${string}`) {
  return {
    name: PERMIT2_DOMAIN_NAME,
    chainId: typeof chainId === "bigint" ? chainId : BigInt(chainId),
    verifyingContract: permit2,
  } as const;
}

/**
 * The typed-data types for `signTypedData`, primary type
 * `PermitWitnessTransferFrom`. Field order matches Permit2's stub and the
 * witness type above; the referenced structs are what the type string names.
 */
export const PERMIT2_WITNESS_TRANSFER_FROM_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "TabSettlement" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  TabSettlement: [
    { name: "serviceId", type: "bytes32" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint128" },
    { name: "surface", type: "address" },
    { name: "chainId", type: "uint256" },
  ],
} as const;

export const PERMIT2_WITNESS_TRANSFER_FROM_PRIMARY_TYPE = "PermitWitnessTransferFrom" as const;

/**
 * The gasless entry point on `TabSettlement`, as a human-readable ABI fragment.
 * `spender` in the signed message is the `TabSettlement` address and `witness`
 * is `TabSettlement.witnessHash(serviceId, asset, amount)`.
 */
export const TAB_SETTLEMENT_PERMIT2_ABI = [
  "function settleWithPermit2(address agent, bytes32 serviceId, address asset, uint128 amount, uint256 nonce, uint256 deadline, bytes signature) returns (bytes32 settlementId, uint128 applied, uint128 toPrepaid)",
  "function witnessHash(bytes32 serviceId, address asset, uint128 amount) view returns (bytes32)",
  "function WITNESS_TYPE_STRING() view returns (string)",
  "function WITNESS_TYPEHASH() view returns (bytes32)",
  "function PERMIT2() view returns (address)",
  "event SettledGasless(bytes32 indexed settlementId, address indexed relayer)",
] as const;

/** The slice of Permit2 a signer or relayer touches, as human-readable ABI. */
export const PERMIT2_ABI = [
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function nonceBitmap(address owner, uint256 wordPosition) view returns (uint256)",
  "function invalidateUnorderedNonces(uint256 wordPos, uint256 mask)",
  "event UnorderedNonceInvalidation(address indexed owner, uint256 word, uint256 mask)",
] as const;

// ---------------------------------------------------------------------------
// ERC-8004
//
// Human-readable fragments copied from `IdentityRegistryUpgradeable` and
// `ReputationRegistryUpgradeable` in erc-8004/erc-8004-contracts, the
// implementations behind the canonical proxies (`getVersion()` reports 2.0.0).
// Only what Tab reads and writes; the ERC-721 and UUPS surface is omitted.
// ---------------------------------------------------------------------------

/**
 * The Identity Registry: an ERC-721 whose token id is the agentId, whose
 * `tokenURI` is the agent's registration file, and whose `agentWallet`
 * metadata is the account acting for the agent. `register` mints to the
 * caller and records it as the wallet; ids are sequential from zero.
 */
export const ERC8004_IDENTITY_REGISTRY_ABI = [
  "function register() returns (uint256 agentId)",
  "function register(string agentURI) returns (uint256 agentId)",
  "function register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)",
  "function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)",
  "function isAuthorizedOrOwner(address spender, uint256 agentId) view returns (bool)",
  "function getVersion() pure returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)",
  "event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
] as const;

/**
 * The Reputation Registry: feedback about an agent, keyed by agentId and the
 * client that gave it, 1-indexed per client. An agent's owner or operator
 * cannot give feedback about it.
 */
export const ERC8004_REPUTATION_REGISTRY_ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function revokeFeedback(uint256 agentId, uint64 feedbackIndex)",
  "function appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex, string responseURI, bytes32 responseHash)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)",
  "function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "function getClients(uint256 agentId) view returns (address[])",
  "function getIdentityRegistry() view returns (address)",
  "function getVersion() pure returns (string)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)",
  "event ResponseAppended(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, address indexed responder, string responseURI, bytes32 responseHash)",
] as const;

/** Canonical ERC-8004 event signatures, for topic filters. */
export const ERC8004_EVENT_SIGNATURES = {
  Registered: "Registered(uint256,string,address)",
  URIUpdated: "URIUpdated(uint256,string,address)",
  MetadataSet: "MetadataSet(uint256,string,string,bytes)",
  NewFeedback: "NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)",
  FeedbackRevoked: "FeedbackRevoked(uint256,address,uint64)",
  ResponseAppended: "ResponseAppended(uint256,address,uint64,address,string,bytes32)",
} as const;

export type Erc8004EventName = keyof typeof ERC8004_EVENT_SIGNATURES;

/** `topics[0]` for each ERC-8004 event, derived from its canonical signature. */
export const ERC8004_EVENT_TOPIC0: Readonly<Record<Erc8004EventName, Bytes32>> = Object.fromEntries(
  Object.entries(ERC8004_EVENT_SIGNATURES).map(([name, signature]) => [name, keccak256Ascii(signature)]),
) as Record<Erc8004EventName, Bytes32>;
