/**
 * The chain toggle: the one control that decides which Source Chain every view
 * on the Dashboard is talking about.
 *
 * ## Why a toggle exists at all
 *
 * Tab settles on two Source Chains and treats them as different worlds, because
 * they are. chainKey `1` is Ethereum Sepolia, where Tab deploys `TabSettlement`
 * and a Settlement is a `TabSettled` event carrying explicit intent. chainKey `3`
 * is Ethereum Mainnet, where Tab deploys nothing at all and a Settlement is a
 * plain ERC-20 `Transfer` to a registered Collection Address (R2.1). The same
 * Agent, the same Service, and the same Asset symbol can appear on both, and a
 * settlement on one says nothing whatever about the other. That is the whole
 * point of authenticating on the `(chainKey, emitter)` pair (R5.1), so a reader
 * who cannot see which chain they are looking at is reading the wrong thing.
 *
 * ## Empty is an answer, not a failure
 *
 * Mainnet is expected to be empty for as long as Tab has settled nothing there,
 * and it will be empty on a first visit rather than exceptionally. So every
 * option carries {@link ChainOption.emptyMeans}, the sentence a view shows in
 * place of rows, and no view is permitted to render an empty chain as an error,
 * as a spinner, or as nothing at all. An empty feed under a horizon that has
 * clearly advanced is a *true statement about the chain*: nothing has settled
 * there. Presenting that as a loading state would be the one failure mode a
 * reader cannot distinguish from a broken page.
 *
 * ## The label is a safety property
 *
 * {@link ChainOption.network} separates test money from real money, and it is
 * surfaced on the control itself rather than inferred from a chain name. Nobody
 * should have to know that "Sepolia" means testnet to read a balance correctly.
 *
 * Requirements: 24.4, 24.9, 2.1, 5.1
 */

import { CHAINS, isSupportedChainKey, type ChainKey } from "@tabai/shared";

/** Whether a chain carries real value. Shown on the control, never inferred. */
export type ChainNetwork = "testnet" | "mainnet";

/** One choice on the toggle. */
export interface ChainOption {
  readonly chainKey: ChainKey;
  /** The chain's own name, from the shared table so it cannot drift. */
  readonly name: string;
  readonly network: ChainNetwork;
  /** Short label for the control itself. */
  readonly shortName: string;
  /** How a Settlement is recognised on this chain, in one clause. */
  readonly settlementShape: string;
  /** True where Tab deploys a contract on the Source Chain. */
  readonly tabDeploysContract: boolean;
  /** What an empty feed on this chain means. Never an error. */
  readonly emptyMeans: string;
}

/**
 * The toggle's options, in display order, testnet first.
 *
 * Sepolia leads because it is the default and because presenting mainnet first
 * invites a reader to assume the figures are real money.
 */
export const CHAIN_OPTIONS: readonly ChainOption[] = [
  {
    chainKey: 1,
    name: CHAINS[1].name,
    network: "testnet",
    shortName: "Sepolia",
    settlementShape: "a TabSettled event from the Tab settlement contract, or a plain Transfer to a Collection Address",
    tabDeploysContract: true,
    emptyMeans: "Nothing has settled on Ethereum Sepolia yet.",
  },
  {
    chainKey: 3,
    name: CHAINS[3].name,
    network: "mainnet",
    shortName: "Mainnet",
    settlementShape: "a plain ERC-20 Transfer to a registered Collection Address, with no Tab contract deployed",
    tabDeploysContract: false,
    emptyMeans:
      "Nothing has settled on Ethereum Mainnet yet. Tab deploys no contract there by design, so this view fills in only once a Settlement is proved from Mainnet.",
  },
];

/**
 * The chain a first-time reader sees.
 *
 * Sepolia, deliberately. A reader who has expressed no preference is shown the
 * chain where the value is not real, because the cost of mistaking testnet for
 * mainnet is smaller than the reverse.
 */
export const DEFAULT_CHAIN_KEY: ChainKey = 1;

/** Query parameter every route reads the chain from. */
export const CHAIN_QUERY_PARAM = "chainKey";

/**
 * Where the choice is remembered per viewer.
 *
 * Versioned, so a later change to what is stored can ignore an old value rather
 * than misread it.
 */
export const CHAIN_STORAGE_KEY = "tab.dashboard.chainKey.v1";

/** The option for a chainKey. Total over {@link ChainKey}, so it cannot fail. */
export function chainOptionFor(chainKey: ChainKey): ChainOption {
  // `CHAIN_OPTIONS` is built from the closed `CHAINS` table, so exactly one
  // option matches every `ChainKey` and the fallback below is unreachable. It is
  // present because `find` cannot be told that, and returning the default is a
  // better answer than a non-null assertion that could one day be wrong.
  return CHAIN_OPTIONS.find((option) => option.chainKey === chainKey) ?? {
    chainKey,
    name: CHAINS[chainKey].name,
    network: chainKey === 3 ? "mainnet" : "testnet",
    shortName: CHAINS[chainKey].name,
    settlementShape: "a recognised Settlement log",
    tabDeploysContract: false,
    emptyMeans: `Nothing has settled on ${CHAINS[chainKey].name} yet.`,
  };
}

/**
 * Reads a chainKey from a query parameter.
 *
 * Anything unrecognised falls back to the default rather than erroring, because
 * a mistyped URL should show a working page on the default chain rather than a
 * stack trace. The parameter is a decimal chainKey, matching the registry read
 * API, which validates the same way.
 */
export function parseChainKeyParam(raw: string | null | undefined): ChainKey {
  if (raw === null || raw === undefined) return DEFAULT_CHAIN_KEY;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_CHAIN_KEY;
  const value = Number.parseInt(trimmed, 10);
  return isSupportedChainKey(value) ? value : DEFAULT_CHAIN_KEY;
}

/**
 * The minimum of `Storage` this module touches.
 *
 * Structural rather than an import of the DOM type, because `src/` compiles
 * against the ES2023 library alone. The same reason `packages/sdk` describes
 * `fetch` structurally.
 */
export interface ChainStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The stored choice, or the default.
 *
 * Every access is guarded. A private window, cleared site data, or a browser set
 * to block storage all throw on access rather than returning null, and none of
 * those is a reason to fail to render a page.
 */
export function readStoredChainKey(storage: ChainStorage | undefined): ChainKey {
  if (storage === undefined) return DEFAULT_CHAIN_KEY;
  try {
    return parseChainKeyParam(storage.getItem(CHAIN_STORAGE_KEY));
  } catch {
    return DEFAULT_CHAIN_KEY;
  }
}

/** Remembers the choice, and does nothing at all where storage refuses. */
export function writeStoredChainKey(storage: ChainStorage | undefined, chainKey: ChainKey): void {
  if (storage === undefined) return;
  try {
    storage.setItem(CHAIN_STORAGE_KEY, String(chainKey));
  } catch {
    // A viewer who cannot persist a preference still gets a working page.
  }
}

/** The href for a route on a given chain, keeping the chain in the URL shareable. */
export function withChainParam(path: string, chainKey: ChainKey): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${CHAIN_QUERY_PARAM}=${chainKey}`;
}
