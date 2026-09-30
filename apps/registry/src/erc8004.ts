/**
 * ERC-8004, the trustless-agent identity and reputation registries, as this
 * service reads them.
 *
 * ## What is here and where it came from
 *
 * The canonical registries are deployed at the same vanity addresses on every
 * supported chain, Monad included. Their sources are the authority for every
 * signature in this file, exactly as `packages/contracts/src/*.sol` is for the Tab
 * events: `vendor/erc8004/IdentityRegistryUpgradeable.sol` is a verbatim copy,
 * below a two-line provenance header, of `contracts/IdentityRegistryUpgradeable.sol`
 * from `github.com/erc-8004/erc-8004-contracts` at commit `b9e466c` (the 2.0.0
 * contracts, which is the version `getVersion()` answers on Monad), and
 * `vendor/erc8004/IERC721.sol` is OpenZeppelin 5.4.0's interface, which is where
 * the `Transfer` the registry inherits is declared. `test/signatures.test.ts`
 * re-reads both and fails when a declaration here drifts from them.
 *
 * ## The identity model
 *
 * The Identity registry is an ERC-721 whose token id is the `agentId`. `register`
 * mints, `setAgentURI` rewrites the agent card's URI, and the token's owner is the
 * agent's owner. Each agent also carries an `agentWallet` metadata entry, set to the
 * registrant at mint, clearable, and cleared on every transfer, which is the address
 * the agent acts from. An Agent on Tab is an account that signs Settlements, so an
 * ERC-8004 agent is matched to a Tab Agent through either of those two addresses.
 *
 * The events indexed are the four that move that state: `Transfer` (owner),
 * `Registered` (mint plus initial URI), `URIUpdated` (URI), and `MetadataSet`
 * (`agentWallet`, among other keys). Nothing is derived at write time; the
 * `registry.agent_identity` view folds the four tables into one row per agent.
 *
 * ## Reputation
 *
 * `ReputationRegistry.getSummary` refuses an empty client list, so a summary is
 * two reads: `getClients(agentId)`, then `getSummary(agentId, clients, "", "")`.
 * Both are `view` functions and cost nothing. An agent with no clients has no
 * feedback, and that is reported as a count of zero from the first read rather
 * than a revert from the second.
 *
 * The registry addresses and the read fragments come from `@tabai/shared`, which
 * is the one source of chain constants for every workspace. What stays here is
 * the event surface the decoder indexes, because it is checked against the
 * vendored source by `test/signatures.test.ts` in the same way Tab's own events
 * are checked against `packages/contracts`, and a test pins its topics to the
 * shared package's so the two cannot drift apart.
 */

import {
  ERC8004_IDENTITY_REGISTRY_ABI as SHARED_IDENTITY_ABI,
  ERC8004_REPUTATION_REGISTRY_ABI as SHARED_REPUTATION_ABI,
  erc8004RegistriesFor,
} from "@tabai/shared";

/** The canonical registries for a chain, lowercase as every address in this service is, or `undefined`. */
export function canonicalErc8004Registries(
  chainId: number,
): { readonly identity: string; readonly reputation: string } | undefined {
  const found = erc8004RegistriesFor(chainId);
  if (found === undefined) return undefined;
  return { identity: found.identity.toLowerCase(), reputation: found.reputation.toLowerCase() };
}

/**
 * The Identity registry events this service indexes, in the human-readable ABI
 * form `ethers` parses. Names are the contracts' own, because the decoder keys
 * the table map on the fragment name.
 */
export const ERC8004_EVENT_DECLARATIONS = {
  /** ERC-721 `Transfer`, inherited from OpenZeppelin: the owner of `tokenId` (the agentId) changed. */
  Transfer: "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  /** A mint. `agentURI` is empty when the registrant used the URI-less `register()`. */
  Registered: "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  /**
   * A metadata entry was written. `indexedMetadataKey` is the same string as
   * `metadataKey`, indexed, so it arrives as its keccak-256 hash; the plain key is
   * the one to read. `agentWallet` rides here, ABI-packed as twenty bytes, or empty
   * when it was unset or cleared by a transfer.
   */
  MetadataSet:
    "event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)",
  /** `setAgentURI` rewrote the agent card's URI. */
  URIUpdated: "event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)",
} as const;

export type Erc8004EventName = keyof typeof ERC8004_EVENT_DECLARATIONS;

/** The reserved metadata key the registry keeps the acting wallet under. */
export const AGENT_WALLET_KEY = "agentWallet";

/** The Identity registry fragments, from the shared package; the route reads `tokenURI` off them. */
export const ERC8004_IDENTITY_READ_ABI = SHARED_IDENTITY_ABI;

/** The Reputation registry fragments, from the shared package; the route reads `getClients` and `getSummary`. */
export const ERC8004_REPUTATION_READ_ABI = SHARED_REPUTATION_ABI;

/** What `getSummary` returns, with the clients the summary spans. */
export interface ReputationSummary {
  readonly clientCount: number;
  /** The clients the summary was asked over, lowercase: every client, or those of them the filter named. */
  readonly clients: readonly string[];
  readonly count: number;
  /** A fixed-point figure; `summaryValueDecimals` says where the point sits. */
  readonly summaryValue: bigint;
  readonly summaryValueDecimals: number;
}

/**
 * Narrows a summary to some clients and tags.
 *
 * `clients` is intersected with `getClients(agentId)` before `getSummary` is
 * asked, because the registry refuses an empty list and a client that never
 * wrote anything adds nothing. An empty tag matches every tag, as the registry
 * defines it.
 */
export interface ReputationFilter {
  readonly clients: readonly string[];
  readonly tag1: string;
  readonly tag2: string;
}

/**
 * Decodes the `agentWallet` metadata value: twenty ABI-packed bytes to a lowercase
 * address, or `null` for the empty value the registry writes on unset and on
 * transfer.
 */
export function decodeAgentWallet(metadataValue: string): string | null {
  const lowered = metadataValue.toLowerCase();
  if (lowered === "0x" || lowered.length === 0) return null;
  if (!/^0x[0-9a-f]{40}$/.test(lowered)) return null;
  return lowered;
}
