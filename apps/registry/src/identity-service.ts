/**
 * The ERC-8004 identity view of one address, served on the Agent read and, for
 * the operator, on the Service read.
 *
 * ## What an identity is here
 *
 * An address holds an ERC-8004 identity when it is the current owner of an
 * agent token, or the current `agentWallet` of one. Both are matched, because
 * either may be the key that signs Settlements on Tab: an operator registers from
 * a cold key and runs the agent from a hot one, and the registry models exactly
 * that split. The rows come from the `registry.agent_identity` view, so every
 * figure has a block it was last written in and the answer is as current as the
 * index horizon and no more.
 *
 * ## What is served beside the index
 *
 * Two things the index does not hold are fetched at read time and served with
 * their own status, never folded into the indexed facts:
 *
 * - **The card.** The registration file the `agentURI` resolves to, fetched
 *   through `agent-card.ts` with a short timeout and a cache. `card` is the JSON
 *   or `null`, and `cardUnavailable` says why when it is `null`, so a missing card
 *   is never mistaken for an empty one.
 * - **Reputation.** `ReputationRegistry.getSummary` over every client that gave
 *   feedback, and again over the operators of registered Tab Services under
 *   Tab's two tags, read live and held for thirty seconds. Withheld and named so
 *   when no Reputation registry or no chain reader is configured, or when the
 *   read fails. Neither figure feeds the Credit Limit.
 *
 * An agent the index knows only through a `Transfer`, because it was minted before
 * the index's start block, has no URI in the index; when a chain reader is wired
 * in, `tokenURI` is read live for it and the source is stated.
 */

import { TAB_SETTLEMENT_FEEDBACK, causeOf } from "@tabai/shared";

import type { CardFetcher, CardUnavailable } from "./agent-card.js";
import type { Erc8004ChainReader } from "./chain-reads.js";
import type { AgentIdentityRow } from "./queries.js";

export interface IdentityRegistries {
  readonly identity: string;
  readonly reputation: string | null;
}

/** What the routes hand this module. Everything but `reads` is optional and its absence is reported, not hidden. */
export interface IdentityDependencies {
  readonly registries: IdentityRegistries;
  readonly cards: CardFetcher;
  readonly chain?: Erc8004ChainReader | undefined;
}

export interface IdentityReads {
  agentIdentities(address: string): Promise<readonly AgentIdentityRow[]>;
  /** The operators of every registered Service: the clients whose feedback counts as Tab's. */
  serviceOperators(): Promise<readonly string[]>;
}

export type ReputationUnavailableCode =
  | "REPUTATION_REGISTRY_UNCONFIGURED"
  | "CHAIN_READER_UNCONFIGURED"
  | "CHAIN_READ_FAILED";

/**
 * What Tab Services said: the same registry, asked over the Service operators
 * only and under Tab's two tags. Every entry is one Settlement a Service
 * received from this Agent, written by that Service afterwards.
 */
export interface TabReputationView {
  readonly tag1: string;
  readonly tag2: string;
  /** Feedback entries from Tab Services under the two tags, not revoked. */
  readonly count: number | null;
  /** The Service operators among the agent's clients. */
  readonly clients: readonly string[] | null;
  readonly summaryValue: string | null;
  readonly summaryValueDecimals: number | null;
  readonly basis: string;
  readonly unavailable: { readonly code: ReputationUnavailableCode; readonly message: string } | null;
}

export interface ReputationView {
  readonly registry: string | null;
  /** Feedback entries the summary spans, not revoked. */
  readonly count: number | null;
  /** Distinct clients that ever gave feedback. */
  readonly clientCount: number | null;
  /** The mean value as a fixed-point decimal string; see `summaryValueDecimals`. */
  readonly summaryValue: string | null;
  readonly summaryValueDecimals: number | null;
  readonly basis: string;
  readonly unavailable: { readonly code: ReputationUnavailableCode; readonly message: string } | null;
  /** The part of it Tab Services wrote. */
  readonly fromTab: TabReputationView;
}

export interface AgentIdentityView {
  readonly agentId: string;
  readonly owner: string;
  readonly agentWallet: string | null;
  /** Which of the two keys matched the address asked about. */
  readonly matchedBy: readonly ("owner" | "agentWallet")[];
  readonly agentURI: string | null;
  /** Where the URI came from: the index, or a live `tokenURI` read when the index had none. */
  readonly agentURISource: "index" | "chain" | null;
  readonly card: unknown;
  readonly cardUnavailable: CardUnavailable | null;
  readonly cardFetchedAt: string | null;
  readonly reputation: ReputationView;
  readonly blocks: {
    readonly registered: number | null;
    readonly owner: number;
    readonly uri: number | null;
    readonly wallet: number | null;
  };
}

export interface IdentityView {
  readonly registry: string;
  readonly basis: string;
  readonly agents: readonly AgentIdentityView[];
}

const IDENTITY_BASIS =
  "ERC-8004 Identity registry Transfer, Registered, URIUpdated and MetadataSet events folded to the current owner, URI and agentWallet per agent as at the index horizon; an agent is listed when either its owner or its agentWallet is this address, and agents registered before the index's start block are visible only through events since it";

const REPUTATION_BASIS =
  "ReputationRegistry.getSummary over every client returned by getClients, read live with no tag filter; summaryValue is a fixed-point mean with summaryValueDecimals decimals";

const TAB_REPUTATION_BASIS = `ReputationRegistry.getSummary over the clients that operate a registered Tab Service, with tag1 "${TAB_SETTLEMENT_FEEDBACK.tag1}" and tag2 "${TAB_SETTLEMENT_FEEDBACK.tag2}", read live; a Service writes one entry of ${TAB_SETTLEMENT_FEEDBACK.value.toString()} after each Settlement it receives, so the count is the signal and the mean is fixed, and each entry's feedbackURI names the Settlement to check against its Settled event; derived from Settlements and never read by the Credit Limit`;

const tabWithheld = (code: ReputationUnavailableCode, message: string): TabReputationView => ({
  tag1: TAB_SETTLEMENT_FEEDBACK.tag1,
  tag2: TAB_SETTLEMENT_FEEDBACK.tag2,
  count: null,
  clients: null,
  summaryValue: null,
  summaryValueDecimals: null,
  basis: TAB_REPUTATION_BASIS,
  unavailable: { code, message },
});

const reputationWithheld = (
  registry: string | null,
  code: ReputationUnavailableCode,
  message: string,
): ReputationView => ({
  registry,
  count: null,
  clientCount: null,
  summaryValue: null,
  summaryValueDecimals: null,
  basis: REPUTATION_BASIS,
  unavailable: { code, message },
  fromTab: tabWithheld(code, message),
});

/** The Tab-only summary, or its own stated reason. A failure here leaves the whole-registry figure standing. */
async function tabReputationOf(chain: Erc8004ChainReader, operators: readonly string[], agentId: bigint): Promise<TabReputationView> {
  try {
    const summary = await chain.reputationSummary(agentId, {
      clients: operators,
      tag1: TAB_SETTLEMENT_FEEDBACK.tag1,
      tag2: TAB_SETTLEMENT_FEEDBACK.tag2,
    });
    if (summary === null) {
      return tabWithheld("REPUTATION_REGISTRY_UNCONFIGURED", "the chain reader has no Reputation registry address, so no summary can be read");
    }
    return {
      tag1: TAB_SETTLEMENT_FEEDBACK.tag1,
      tag2: TAB_SETTLEMENT_FEEDBACK.tag2,
      count: summary.count,
      clients: summary.clients,
      summaryValue: summary.summaryValue.toString(),
      summaryValueDecimals: summary.summaryValueDecimals,
      basis: TAB_REPUTATION_BASIS,
      unavailable: null,
    };
  } catch (error) {
    return tabWithheld("CHAIN_READ_FAILED", `ReputationRegistry could not be read: ${causeOf(error).message}`);
  }
}

async function reputationOf(
  deps: IdentityDependencies,
  operators: () => Promise<readonly string[]>,
  agentId: bigint,
): Promise<ReputationView> {
  const registry = deps.registries.reputation;
  if (registry === null) {
    return reputationWithheld(
      null,
      "REPUTATION_REGISTRY_UNCONFIGURED",
      "no ERC-8004 Reputation registry is configured for this chain, so no summary can be read",
    );
  }
  if (deps.chain === undefined) {
    return reputationWithheld(
      registry,
      "CHAIN_READER_UNCONFIGURED",
      "this process has no Monad endpoint wired in, so ReputationRegistry.getSummary cannot be read",
    );
  }
  const chain = deps.chain;
  try {
    const [summary, fromTab] = await Promise.all([
      chain.reputationSummary(agentId),
      operators().then(
        (list) => tabReputationOf(chain, list, agentId),
        (error: unknown) =>
          tabWithheld("CHAIN_READ_FAILED", `the Service operators could not be read from the index: ${causeOf(error).message}`),
      ),
    ]);
    if (summary === null) {
      return reputationWithheld(
        registry,
        "REPUTATION_REGISTRY_UNCONFIGURED",
        "the chain reader has no Reputation registry address, so no summary can be read",
      );
    }
    return {
      registry,
      count: summary.count,
      clientCount: summary.clientCount,
      summaryValue: summary.summaryValue.toString(),
      summaryValueDecimals: summary.summaryValueDecimals,
      basis: REPUTATION_BASIS,
      unavailable: null,
      fromTab,
    };
  } catch (error) {
    return reputationWithheld(
      registry,
      "CHAIN_READ_FAILED",
      `ReputationRegistry could not be read: ${causeOf(error).message}`,
    );
  }
}

function matchedByOf(address: string, row: AgentIdentityRow): readonly ("owner" | "agentWallet")[] {
  const matchedBy: ("owner" | "agentWallet")[] = [];
  if (row.owner === address) matchedBy.push("owner");
  if (row.agentWallet === address) matchedBy.push("agentWallet");
  return matchedBy;
}

/** One read of the operator list per request, however many agents the address holds. */
function operatorsOnce(reads: IdentityReads): () => Promise<readonly string[]> {
  let pending: Promise<readonly string[]> | undefined;
  return () => (pending ??= reads.serviceOperators());
}

async function uriOf(
  deps: IdentityDependencies,
  row: AgentIdentityRow,
): Promise<{ readonly uri: string | null; readonly source: "index" | "chain" | null }> {
  if (row.agentUri !== null) return { uri: row.agentUri, source: "index" };
  if (deps.chain === undefined) return { uri: null, source: null };
  try {
    return { uri: await deps.chain.tokenURI(BigInt(row.agentId)), source: "chain" };
  } catch {
    return { uri: null, source: null };
  }
}

async function toAgentView(
  deps: IdentityDependencies,
  operators: () => Promise<readonly string[]>,
  address: string,
  row: AgentIdentityRow,
): Promise<AgentIdentityView> {
  const agentId = BigInt(row.agentId);
  const [{ uri, source }, reputation] = await Promise.all([uriOf(deps, row), reputationOf(deps, operators, agentId)]);
  // An empty URI is what the URI-less `register()` leaves behind: nothing to
  // fetch, and stated as such rather than handed to the fetcher as an address.
  const card =
    uri === null || uri.length === 0
      ? {
          ok: false as const,
          error: {
            code: "CARD_URI_EMPTY" as const,
            message: uri === null ? "the agent has no URI in the index and none could be read" : "the agent has no URI set",
          },
        }
      : await deps.cards.fetch(uri);
  return {
    agentId: row.agentId,
    owner: row.owner,
    agentWallet: row.agentWallet,
    matchedBy: matchedByOf(address, row),
    agentURI: uri,
    agentURISource: source,
    card: card.ok ? card.value : null,
    cardUnavailable: card.ok ? null : card.error,
    cardFetchedAt: card.ok ? card.fetchedAt : null,
    reputation,
    blocks: {
      registered: row.registeredBlock,
      owner: row.ownerBlock,
      uri: row.uriBlock,
      wallet: row.walletBlock,
    },
  };
}

/**
 * The identity view of one address, or `null` when identity is not configured for
 * this deployment. An address with no agent is `{ agents: [] }` under the stated
 * basis: the index looked and found none, which is an answer.
 */
export async function identityOf(
  reads: IdentityReads,
  deps: IdentityDependencies | undefined,
  address: string,
): Promise<IdentityView | null> {
  if (deps === undefined) return null;
  const rows = await reads.agentIdentities(address);
  const operators = operatorsOnce(reads);
  const agents = await Promise.all(rows.map((row) => toAgentView(deps, operators, address, row)));
  return { registry: deps.registries.identity, basis: IDENTITY_BASIS, agents };
}

/** One agent on the reputation read: who it is and what the Reputation registry holds about it. */
export interface AgentReputationView {
  readonly agentId: string;
  readonly owner: string;
  readonly agentWallet: string | null;
  readonly matchedBy: readonly ("owner" | "agentWallet")[];
  readonly reputation: ReputationView;
}

export interface ReputationOfAddressView {
  readonly identityRegistry: string;
  readonly reputationRegistry: string | null;
  readonly basis: string;
  readonly agents: readonly AgentReputationView[];
}

/**
 * The reputation of every ERC-8004 agent an address holds, without the
 * registration file: the light read a Service makes to find the agentId it
 * writes feedback against, and that a reader makes to check what was written.
 * `null` when identity is not configured, `{ agents: [] }` when the address
 * holds no agent.
 */
export async function reputationOfAddress(
  reads: IdentityReads,
  deps: IdentityDependencies | undefined,
  address: string,
): Promise<ReputationOfAddressView | null> {
  if (deps === undefined) return null;
  const rows = await reads.agentIdentities(address);
  const operators = operatorsOnce(reads);
  const agents = await Promise.all(
    rows.map(async (row) => ({
      agentId: row.agentId,
      owner: row.owner,
      agentWallet: row.agentWallet,
      matchedBy: matchedByOf(address, row),
      reputation: await reputationOf(deps, operators, BigInt(row.agentId)),
    })),
  );
  return {
    identityRegistry: deps.registries.identity,
    reputationRegistry: deps.registries.reputation,
    basis: IDENTITY_BASIS,
    agents,
  };
}
