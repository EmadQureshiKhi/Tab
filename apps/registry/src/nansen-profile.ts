/**
 * A Nansen profile of an Agent's address, bought per call over x402 and kept
 * for a week.
 *
 * ## What it is
 *
 * Three of Nansen's profiler endpoints, each a cent in USDC on Monad Mainnet,
 * paid with no account and no API credits: what the address holds now
 * (`current-balance`), who funded it (`related-wallets`), and what it did in the
 * last thirty days (`transactions`), from which the counterparties it dealt with
 * most are counted, with Nansen's own names for them. None of it is on chain in
 * a form Tab can check, so it is served as an overlay with a named source and the
 * time Nansen answered, beside the indexed facts and never mixed into them.
 *
 * ## Asked once a week, whoever is looking
 *
 * The first read of an Agent pays for the three calls and stores the answer in
 * `registry.nansen_profile`. Every read for the next seven days is served from
 * that row, to every reader, and nothing is paid. The next read after that pays
 * again. The row is in the database rather than in memory, so a restart or a
 * redeploy does not buy the same answer twice, and concurrent first reads of one
 * address share one purchase.
 *
 * ## What stops it from being spent by strangers
 *
 * - Only an address this registry already knows as an Agent is looked up: one
 *   with an authorisation, a metered delivery or a Settlement on this network.
 *   Any other address is answered with a stated refusal, and nothing is paid, so
 *   loading a thousand random addresses costs nothing.
 * - Every payment is recorded in `registry.nansen_payment`, and a lookup that
 *   would take the last day's spending past the budget is not made.
 * - Each call refuses to pay more than a cent, so a repriced endpoint is refused
 *   rather than paid.
 * - A lookup that failed is not retried for ten minutes, and a row that could not
 *   be refreshed is served as it was, marked stale, rather than withdrawn.
 *
 * ## One call at a time, and only what is missing
 *
 * Nansen rate-limits a burst: three paid calls at once had the third answered
 * `429`, before anything was settled. So the calls go one after another, and a
 * `429` is asked again after a pause, which is safe because nothing was paid for
 * the refused one. A section that still could not be read is stored as the
 * reason, and it alone is bought again on a read ten minutes later, rather than
 * leaving that section empty for the rest of the week or paying for the other
 * two twice.
 *
 * ## Mainnet only
 *
 * Nansen's `monad` chain is Monad Mainnet, and x402 pays in Mainnet USDC. A
 * registry indexing Testnet serves a stated refusal instead.
 */

import type { Result } from "@tabai/shared";

export const NANSEN_PROFILER_URL = "https://api.nansen.ai/api/v1/profiler/address";

/** How long a profile is served before the next read buys a fresh one. */
export const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a failed lookup is remembered, so a broken upstream is not paid in a loop. */
export const PROFILE_FAILURE_TTL_MS = 10 * 60 * 1000;

/** The most one call may cost, in USDC base units: a cent, Nansen's price for each endpoint used. */
export const NANSEN_CALL_CEILING = 10_000n;

/** Spending allowed over any 24 hours, in USDC base units, unless configured. */
export const DEFAULT_DAILY_BUDGET = 250_000n;

/** The window the activity section covers. */
export const ACTIVITY_WINDOW_DAYS = 30;

/** Monad Mainnet, the one chain Nansen's `monad` slug covers. */
const MAINNET_CHAIN_ID = 143;

const ENDPOINTS = ["current-balance", "related-wallets", "transactions"] as const;
type Endpoint = (typeof ENDPOINTS)[number];

/** Which section of the profile each endpoint fills. */
const SECTION_OF = { "current-balance": "holdings", "related-wallets": "funding", transactions: "activity" } as const;

/** The pauses before asking again after a `429`. */
const RATE_LIMIT_RETRY_MS: readonly number[] = [1_500, 4_000];

/** How many rows of each list are served. */
const SHOWN = 5;
/** How many transactions are read to count counterparties; Nansen's page ceiling. */
const TRANSACTIONS_READ = 100;

// ------------------------------------------------------------------ the served shape

export type NansenProfileCode =
  | "NANSEN_MAINNET_ONLY"
  | "NANSEN_PAYER_MISSING"
  | "NANSEN_NOT_AN_AGENT"
  | "NANSEN_BUDGET_SPENT"
  | "NANSEN_PAYMENT_FAILED"
  | "NANSEN_UPSTREAM_ERROR"
  | "NANSEN_MALFORMED_RESPONSE"
  | "NANSEN_STORE_FAILED";

export interface Unavailable {
  readonly unavailable: { readonly code: NansenProfileCode; readonly message: string };
}

export interface Holdings {
  /** Nansen's valuation, in US dollars. Null where Nansen prices none of the tokens. */
  readonly totalUsd: number | null;
  readonly tokens: readonly { readonly symbol: string; readonly amount: number; readonly valueUsd: number | null }[];
}

export interface Funding {
  readonly wallets: readonly {
    readonly address: string;
    /** Nansen's name for the wallet; null where Nansen only abbreviates the address. */
    readonly label: string | null;
    readonly relation: string;
    readonly txHash: string | null;
    readonly at: string | null;
  }[];
}

export interface Activity {
  readonly windowDays: number;
  /** Transactions in the window, as far as the page read; `more` says there were others. */
  readonly transactions: number;
  readonly more: boolean;
  readonly volumeUsd: number | null;
  readonly lastAt: string | null;
  readonly counterparties: readonly { readonly address: string; readonly label: string | null; readonly transactions: number }[];
}

/** What is stored, and served with its dates. */
export interface StoredProfile {
  readonly paid: {
    readonly asset: string;
    readonly totalBaseUnits: string;
    readonly payments: readonly { readonly endpoint: string; readonly amountBaseUnits: string; readonly txHash: string | null }[];
  };
  readonly holdings: Holdings | Unavailable;
  readonly funding: Funding | Unavailable;
  readonly activity: Activity | Unavailable;
}

export type NansenProfileView =
  | (StoredProfile & {
      readonly source: "nansen";
      readonly chain: "monad";
      readonly address: string;
      readonly fetchedAt: string;
      readonly refreshesAt: string;
      /** True when the week is up and the refresh could not be made; the row is served as it was. */
      readonly stale: boolean;
    })
  | ({ readonly source: "nansen" } & Unavailable);

// ------------------------------------------------------------------ the seams

/** One paid call's answer, and the payment that bought it. */
export interface PaidCall {
  readonly status: number;
  readonly body: unknown;
  readonly payment?: { readonly amount: bigint; readonly asset: string; readonly txHash: string };
}

/** POSTs a body to a Nansen URL, paying the `402` it answers with. */
export type PaidFetch = (url: string, body: unknown) => Promise<Result<PaidCall>>;

export interface ProfileStore {
  read(address: string): Promise<{ readonly fetchedAt: Date; readonly profile: StoredProfile } | null>;
  write(address: string, fetchedAt: Date, profile: StoredProfile): Promise<void>;
  recordPayment(payment: {
    readonly address: string;
    readonly endpoint: string;
    readonly amount: bigint;
    readonly asset: string;
    readonly txHash: string | null;
  }): Promise<void>;
  /** Base units paid to Nansen since the instant. */
  spentSince(since: Date): Promise<bigint>;
  /** True when the address has an authorisation, a delivery or a Settlement indexed on this network. */
  isAgent(address: string): Promise<boolean>;
}

export interface NansenProfileSource {
  profileFor(address: string): Promise<NansenProfileView>;
}

export interface NansenProfileOptions {
  readonly chainId: number;
  readonly store: ProfileStore;
  /** Null when no payer key is configured; stored rows are still served. */
  readonly paidFetch: PaidFetch | null;
  readonly dailyBudget?: bigint;
  readonly ttlMs?: number;
  readonly failureTtlMs?: number;
  readonly now?: () => number;
  readonly url?: string;
  readonly warn?: (message: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

// ------------------------------------------------------------------ parsing

const unavailable = (code: NansenProfileCode, message: string): Unavailable => ({ unavailable: { code, message } });

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const rowsOf = (body: unknown): readonly unknown[] | null => {
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : null;
};
const field = (row: unknown, name: string): unknown => (typeof row === "object" && row !== null ? (row as Record<string, unknown>)[name] : undefined);
const isAddress = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * Nansen's name for an address, or null where it has none. Nansen writes an
 * unnamed address as its first six hex digits in brackets, which is not a name,
 * and pads some names with zero-width characters, which are dropped.
 */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[​-‍⁠﻿]/g, "").trim();
  if (cleaned.length === 0 || /^\[0x[0-9a-f]{6}\]$/i.test(cleaned)) return null;
  return cleaned;
}

export function parseHoldings(body: unknown): Holdings | null {
  const rows = rowsOf(body);
  if (rows === null) return null;
  const tokens = rows
    .map((row) => ({
      symbol: text(field(row, "token_symbol")) ?? "?",
      amount: finite(field(row, "token_amount")) ?? 0,
      valueUsd: finite(field(row, "value_usd")),
    }))
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const priced = tokens.filter((token) => token.valueUsd !== null);
  return {
    totalUsd: priced.length === 0 ? null : priced.reduce((sum, token) => sum + (token.valueUsd ?? 0), 0),
    tokens: tokens.slice(0, SHOWN),
  };
}

export function parseFunding(body: unknown): Funding | null {
  const rows = rowsOf(body);
  if (rows === null) return null;
  const wallets = rows
    .filter((row) => isAddress(field(row, "address")))
    .map((row) => ({
      address: String(field(row, "address")).toLowerCase(),
      label: cleanLabel(field(row, "address_label")),
      relation: text(field(row, "relation")) ?? "related",
      txHash: text(field(row, "transaction_hash")),
      at: text(field(row, "block_timestamp")),
    }));
  return { wallets: wallets.slice(0, SHOWN) };
}

/** Counts the addresses on the other side of each transfer, with Nansen's name for each where it has one. */
export function parseActivity(body: unknown, self: string): Activity | null {
  const rows = rowsOf(body);
  if (rows === null) return null;
  const me = self.toLowerCase();
  const counts = new Map<string, { label: string | null; transactions: number }>();
  let volume = 0;
  let priced = false;
  let lastAt: string | null = null;
  for (const row of rows) {
    const usd = finite(field(row, "volume_usd"));
    if (usd !== null) {
      volume += usd;
      priced = true;
    }
    const at = text(field(row, "block_timestamp"));
    if (at !== null && (lastAt === null || at > lastAt)) lastAt = at;
    const seen = new Map<string, string | null>();
    for (const [list, side] of [
      ["tokens_sent", "to"],
      ["tokens_received", "from"],
    ] as const) {
      const legs = field(row, list);
      if (!Array.isArray(legs)) continue;
      for (const leg of legs) {
        const other = field(leg, `${side}_address`);
        if (!isAddress(other) || other.toLowerCase() === me) continue;
        const key = other.toLowerCase();
        seen.set(key, seen.get(key) ?? cleanLabel(field(leg, `${side}_address_label`)));
      }
    }
    for (const [address, label] of seen) {
      const entry = counts.get(address);
      counts.set(address, { label: entry?.label ?? label, transactions: (entry?.transactions ?? 0) + 1 });
    }
  }
  const counterparties = [...counts.entries()]
    .map(([address, entry]) => ({ address, label: entry.label, transactions: entry.transactions }))
    .sort((a, b) => b.transactions - a.transactions || a.address.localeCompare(b.address))
    .slice(0, SHOWN);
  const lastPage = field(field(body, "pagination"), "is_last_page");
  return {
    windowDays: ACTIVITY_WINDOW_DAYS,
    transactions: rows.length,
    more: lastPage === false,
    volumeUsd: priced ? volume : null,
    lastAt,
    counterparties,
  };
}

// ------------------------------------------------------------------ the source

/** The source a registry with no Nansen profile wired in serves. */
export const nansenProfileUnconfigured = (message: string): NansenProfileSource => ({
  async profileFor(): Promise<NansenProfileView> {
    return { source: "nansen", ...unavailable("NANSEN_PAYER_MISSING", message) };
  },
});

export function createNansenProfiles(options: NansenProfileOptions): NansenProfileSource {
  const { store, paidFetch } = options;
  const budget = options.dailyBudget ?? DEFAULT_DAILY_BUDGET;
  const ttl = options.ttlMs ?? PROFILE_TTL_MS;
  const failureTtl = options.failureTtlMs ?? PROFILE_FAILURE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const base = (options.url ?? NANSEN_PROFILER_URL).replace(/\/+$/, "");
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const failures = new Map<string, { readonly until: number; readonly view: NansenProfileView }>();
  const inFlight = new Map<string, Promise<NansenProfileView>>();

  const refusal = (code: NansenProfileCode, message: string): NansenProfileView => ({ source: "nansen", ...unavailable(code, message) });

  const served = (address: string, fetchedAt: Date, profile: StoredProfile, stale: boolean): NansenProfileView => ({
    source: "nansen",
    chain: "monad",
    address,
    fetchedAt: fetchedAt.toISOString(),
    refreshesAt: new Date(fetchedAt.getTime() + ttl).toISOString(),
    stale,
    ...profile,
  });

  const bodyFor = (endpoint: Endpoint, address: string): unknown => {
    if (endpoint !== "transactions") return { address, chain: "monad", pagination: { page: 1, per_page: SHOWN * 2 } };
    const day = (at: number): string => new Date(at).toISOString().slice(0, 10);
    const to = now();
    return {
      address,
      chain: "monad",
      date: { from: day(to - ACTIVITY_WINDOW_DAYS * 86_400_000), to: day(to) },
      pagination: { page: 1, per_page: TRANSACTIONS_READ },
    };
  };

  /** One endpoint: pay, record the payment whatever the answer, and parse. */
  const ask = async (
    fetchPaid: PaidFetch,
    endpoint: Endpoint,
    address: string,
  ): Promise<{ readonly section: unknown; readonly payment: StoredProfile["paid"]["payments"][number] | null; readonly asset: string | null }> => {
    let answered = await fetchPaid(`${base}/${endpoint}`, bodyFor(endpoint, address));
    // A 429 carries no settlement, so nothing was paid and asking again is safe.
    for (const pause of RATE_LIMIT_RETRY_MS) {
      if (!answered.ok || answered.value.status !== 429 || answered.value.payment !== undefined) break;
      await sleep(pause);
      answered = await fetchPaid(`${base}/${endpoint}`, bodyFor(endpoint, address));
    }
    if (!answered.ok) {
      return { section: unavailable("NANSEN_PAYMENT_FAILED", `${endpoint}: ${answered.error.message}`), payment: null, asset: null };
    }
    const { status, body, payment } = answered.value;
    let receipt: StoredProfile["paid"]["payments"][number] | null = null;
    if (payment !== undefined) {
      const txHash = payment.txHash.length > 0 ? payment.txHash : null;
      receipt = { endpoint, amountBaseUnits: payment.amount.toString(), txHash };
      try {
        await store.recordPayment({ address, endpoint, amount: payment.amount, asset: payment.asset.toLowerCase(), txHash });
      } catch (error) {
        warn(`registry: a Nansen payment for ${address} could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (status < 200 || status >= 300) {
      return { section: unavailable("NANSEN_UPSTREAM_ERROR", `${endpoint}: Nansen answered ${status}`), payment: receipt, asset: payment?.asset ?? null };
    }
    const parsed =
      endpoint === "current-balance" ? parseHoldings(body) : endpoint === "related-wallets" ? parseFunding(body) : parseActivity(body, address);
    return {
      section: parsed ?? unavailable("NANSEN_MALFORMED_RESPONSE", `${endpoint}: the body did not carry a data array`),
      payment: receipt,
      asset: payment?.asset ?? null,
    };
  };

  type Stored = { readonly fetchedAt: Date; readonly profile: StoredProfile };

  /** The endpoints whose sections a stored profile is missing. */
  const missingOf = (profile: StoredProfile): readonly Endpoint[] =>
    ENDPOINTS.filter((endpoint) => "unavailable" in profile[SECTION_OF[endpoint]]);

  /**
   * Buys the endpoints given, one after another. With a stored profile that is
   * still in its week, only its missing sections are asked for and merged in;
   * otherwise all three, and the week starts again.
   */
  const refresh = async (address: string, stored: Stored | null, endpoints: readonly Endpoint[]): Promise<NansenProfileView> => {
    const partial = endpoints.length < ENDPOINTS.length && stored !== null;
    const fallBack = (view: NansenProfileView): NansenProfileView => {
      failures.set(address, { until: now() + failureTtl, view });
      return stored === null ? view : served(address, stored.fetchedAt, stored.profile, !partial);
    };
    if (paidFetch === null) {
      return fallBack(refusal("NANSEN_PAYER_MISSING", "no NANSEN_X402_PRIVATE_KEY is configured, so no Nansen profile is bought"));
    }
    try {
      if (stored === null && !(await store.isAgent(address))) {
        return fallBack(
          refusal("NANSEN_NOT_AN_AGENT", "this address has no authorisation, delivery or Settlement on this network, so no Nansen profile is bought for it"),
        );
      }
      const spent = await store.spentSince(new Date(now() - 86_400_000));
      if (spent + NANSEN_CALL_CEILING * BigInt(endpoints.length) > budget) {
        return fallBack(refusal("NANSEN_BUDGET_SPENT", `the day's Nansen budget of ${budget} base units is spent (${spent} in the last 24 hours)`));
      }
    } catch (error) {
      return fallBack(refusal("NANSEN_STORE_FAILED", `the profile store could not be read: ${error instanceof Error ? error.message : String(error)}`));
    }

    const answers: { readonly endpoint: Endpoint; readonly answer: Awaited<ReturnType<typeof ask>> }[] = [];
    for (const endpoint of endpoints) answers.push({ endpoint, answer: await ask(paidFetch, endpoint, address) });
    if (answers.every(({ answer }) => "unavailable" in (answer.section as object))) {
      const first = (answers[0]?.answer.section as Unavailable).unavailable;
      return fallBack(refusal(first.code, first.message));
    }

    const base: StoredProfile = partial
      ? stored.profile
      : {
          paid: { asset: "", totalBaseUnits: "0", payments: [] },
          holdings: unavailable("NANSEN_UPSTREAM_ERROR", "current-balance: not asked"),
          funding: unavailable("NANSEN_UPSTREAM_ERROR", "related-wallets: not asked"),
          activity: unavailable("NANSEN_UPSTREAM_ERROR", "transactions: not asked"),
        };
    const sections: Record<string, unknown> = {};
    for (const { endpoint, answer } of answers) sections[SECTION_OF[endpoint]] = answer.section;
    const payments = [
      ...base.paid.payments,
      ...answers.flatMap(({ answer }) => (answer.payment === null ? [] : [answer.payment])),
    ];
    const profile: StoredProfile = {
      ...base,
      ...(sections as Partial<StoredProfile>),
      paid: {
        asset: (base.paid.asset || answers.find(({ answer }) => answer.asset !== null)?.answer.asset || "").toLowerCase(),
        totalBaseUnits: payments.reduce((sum, payment) => sum + BigInt(payment.amountBaseUnits), 0n).toString(),
        payments,
      },
    };
    const fetchedAt = partial ? stored.fetchedAt : new Date(now());
    try {
      await store.write(address, fetchedAt, profile);
    } catch (error) {
      warn(`registry: the Nansen profile for ${address} could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (missingOf(profile).length > 0) {
      // Served now, and the missing part is not asked for again for a while.
      failures.set(address, { until: now() + failureTtl, view: refusal("NANSEN_UPSTREAM_ERROR", "a section is still missing") });
    } else {
      failures.delete(address);
    }
    return served(address, fetchedAt, profile, false);
  };

  const once = (address: string, run: () => Promise<NansenProfileView>): Promise<NansenProfileView> => {
    const pending = inFlight.get(address);
    if (pending !== undefined) return pending;
    const promise = run().finally(() => inFlight.delete(address));
    inFlight.set(address, promise);
    return promise;
  };

  return {
    async profileFor(raw: string): Promise<NansenProfileView> {
      const address = raw.toLowerCase();
      if (options.chainId !== MAINNET_CHAIN_ID) {
        return refusal("NANSEN_MAINNET_ONLY", `Nansen covers Monad Mainnet, and this registry indexes chain ${options.chainId}`);
      }
      let stored: { fetchedAt: Date; profile: StoredProfile } | null;
      try {
        stored = await store.read(address);
      } catch (error) {
        return refusal("NANSEN_STORE_FAILED", `the profile store could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      const failed = failures.get(address);
      const resting = failed !== undefined && failed.until > now();
      if (stored !== null && stored.fetchedAt.getTime() + ttl > now()) {
        const missing = missingOf(stored.profile);
        if (missing.length === 0 || resting) return served(address, stored.fetchedAt, stored.profile, false);
        return once(address, () => refresh(address, stored, missing));
      }
      if (resting) return stored === null ? failed.view : served(address, stored.fetchedAt, stored.profile, true);
      return once(address, () => refresh(address, stored, ENDPOINTS));
    },
  };
}
