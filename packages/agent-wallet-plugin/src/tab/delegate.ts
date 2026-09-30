/**
 * `mm tab delegate`: name a local session key that may sign this wallet's
 * metering claims, or withdraw it.
 *
 * The host gives a plugin no way to sign a message, and a gateway on the open
 * internet meters only a signed call. So the wallet submits one transaction,
 * `MeteringDelegates.setDelegate(delegate, expiry)`, and the key it names signs
 * each `mm tab call` from then on. The key is made here and kept in its own
 * file (`delegate-key.ts`); only its address is ever printed.
 *
 * The bound is the point, and it is stated in every report: the delegate signs
 * metering claims and nothing else. It cannot move funds, every charge it
 * causes still passes this wallet's `TabBook.authorise` ceiling and expiry for
 * that Service and Asset, it lapses at the expiry set here, and
 * `--revoke --broadcast` withdraws it in one transaction.
 *
 * A dry run by default, like `settle` and `authorise`. The dry run does write
 * the key file when there is none, so the transaction it prints is the exact
 * one a broadcast would submit.
 */

import type { Address, Result } from "@tabai/sdk";
import { err, ok, validationError } from "@tabai/sdk";

import {
  decodeDelegatesWord,
  encodeExpiryOf,
  encodeIsDelegate,
  encodeRevokeDelegate,
  encodeSetDelegate,
  UINT64_MAX,
} from "../calldata.js";
import { createDelegateKeyStore, type DelegateKey, type DelegateKeyStore } from "../delegate-key.js";
import type { Host, PlannedTransaction } from "../host-context.js";
import { MAINNET_CHAIN_ID } from "../defaults.js";
import { explorerTxUrl, type PluginSettings } from "../settings.js";
import type { PlannedTransactionView, SubmittedView } from "./settle.js";

/** How long a delegation lasts when `--days` is not given. */
export const DEFAULT_DELEGATION_DAYS = 30;

/** The contract's own bound, `MeteringDelegates.MAX_DELEGATION`, in days. */
export const MAX_DELEGATION_DAYS = 365;

/** What a delegate can do, said the same way in every report. */
export const DELEGATE_BOUND =
  "A delegate signs metering claims and nothing else: it cannot move funds, every charge it causes stays within this wallet's TabBook.authorise ceiling and expiry for that Service and Asset, and `mm tab delegate --revoke --broadcast` withdraws it in one transaction.";

export interface DelegateInputs {
  /** Whole days from now until the delegation lapses. Defaults to 30. */
  readonly days?: string | undefined;
  readonly revoke: boolean;
  readonly broadcast: boolean;
}

export interface DelegateDeps {
  readonly host: Host;
  readonly settings: PluginSettings;
  /** Where the key file lives. Defaults to `~/.config/tab/delegates`. */
  readonly store?: DelegateKeyStore | undefined;
  /** Milliseconds since the epoch. Defaults to the machine clock. */
  readonly now?: (() => number) | undefined;
}

export interface DelegateReport {
  readonly chainId: number;
  readonly broadcast: boolean;
  readonly action: "register" | "revoke";
  readonly agent: Address;
  /** The delegate's address. Its key stays in `keyFile` and is never printed. */
  readonly delegate: Address;
  readonly meteringDelegates: Address;
  readonly keyFile: string;
  /** True when this run generated the key. */
  readonly keyCreated: boolean;
  /** The delegation on chain before this command, as an ISO time, or null when there is none or it lapsed. */
  readonly registeredUntil: string | null;
  /** The expiry a registration sets, in seconds since the epoch. Absent on a revocation. */
  readonly expiry?: number;
  readonly expiryIso?: string;
  readonly transaction: PlannedTransactionView;
  readonly tx?: SubmittedView;
  readonly bound: string;
  readonly note: string;
}

const networkName = (chainId: number): string => (chainId === MAINNET_CHAIN_ID ? "Monad Mainnet" : "Monad Testnet");

/** `MeteringDelegates` on the configured chain, or the refusal that names why there is none. */
export function meteringDelegatesOf(settings: PluginSettings): Result<Address> {
  if (settings.meteringDelegates !== undefined) return ok(settings.meteringDelegates);
  return err({
    category: "NOT_FOUND",
    code: "METERING_DELEGATES_UNDEPLOYED",
    message: `no MeteringDelegates contract is known on ${networkName(settings.chainId)}, so a metering delegate cannot be registered there; set METERING_DELEGATES_ADDRESS to one deployed on chain ${settings.chainId}`,
    retryable: false,
    details: { chainId: settings.chainId },
  });
}

/** Days from a CLI string: a whole number from 1 to the contract's bound. */
export function parseDelegationDays(raw: string | undefined): Result<number> {
  if (raw === undefined || raw.trim() === "") return ok(DEFAULT_DELEGATION_DAYS);
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text) || Number(text) === 0) {
    return validationError("DAYS_MALFORMED", `--days must be a whole number of days greater than zero, received \`${raw}\``, {
      details: { value: raw },
    });
  }
  const days = Number(text);
  if (days > MAX_DELEGATION_DAYS) {
    return validationError(
      "DAYS_TOO_FAR",
      `--days must be at most ${MAX_DELEGATION_DAYS}: MeteringDelegates refuses an expiry more than a year ahead, so a forgotten key lapses on its own`,
      { details: { value: raw } },
    );
  }
  return ok(days);
}

/** `MeteringDelegates.expiryOf(agent, delegate)`, in seconds; zero when never set or revoked. */
export async function readDelegateExpiry(host: Host, settings: PluginSettings, at: Address, agent: Address, delegate: Address): Promise<Result<bigint>> {
  const returned = await host.chain(settings.chainId).call(at, encodeExpiryOf(agent, delegate));
  if (!returned.ok) return returned;
  return decodeDelegatesWord(returned.value, "expiryOf");
}

/** `MeteringDelegates.isDelegate(agent, delegate)`: whether the chain counts the key now. */
export async function readIsDelegate(host: Host, settings: PluginSettings, at: Address, agent: Address, delegate: Address): Promise<Result<boolean>> {
  const returned = await host.chain(settings.chainId).call(at, encodeIsDelegate(agent, delegate));
  if (!returned.ok) return returned;
  const word = decodeDelegatesWord(returned.value, "isDelegate");
  if (!word.ok) return word;
  return ok(word.value !== 0n);
}

const isoOf = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

export async function runDelegate(deps: DelegateDeps, inputs: DelegateInputs): Promise<Result<DelegateReport>> {
  const settings = deps.settings;
  const store = deps.store ?? createDelegateKeyStore();
  const now = deps.now ?? (() => Date.now());

  if (inputs.revoke && inputs.days !== undefined && inputs.days.trim() !== "") {
    return validationError("DELEGATE_FLAGS_CONFLICT", "--revoke withdraws the delegate outright, so it takes no --days");
  }
  const days = inputs.revoke ? ok(0) : parseDelegationDays(inputs.days);
  if (!days.ok) return days;

  const at = meteringDelegatesOf(settings);
  if (!at.ok) return at;
  const agent = deps.host.wallet().address();
  if (!agent.ok) return agent;

  let key: DelegateKey;
  if (inputs.revoke) {
    const stored = store.load(settings.chainId, agent.value);
    if (!stored.ok) return stored;
    if (stored.value === undefined) {
      return err({
        category: "NOT_FOUND",
        code: "DELEGATE_KEY_MISSING",
        message: `no metering delegate key is stored for ${agent.value} on ${networkName(settings.chainId)} at ${store.pathFor(settings.chainId, agent.value)}, so there is nothing this command registered to revoke`,
        retryable: false,
      });
    }
    key = stored.value;
  } else {
    const made = store.loadOrCreate(settings.chainId, agent.value);
    if (!made.ok) return made;
    key = made.value;
  }

  const current = await readDelegateExpiry(deps.host, settings, at.value, agent.value, key.address);
  if (!current.ok) return current;
  const nowSeconds = BigInt(Math.floor(now() / 1000));
  const registeredUntil = current.value > nowSeconds ? isoOf(current.value) : null;

  const base = {
    chainId: settings.chainId,
    agent: agent.value,
    delegate: key.address,
    meteringDelegates: at.value,
    keyFile: key.path,
    keyCreated: key.created,
    registeredUntil,
    bound: DELEGATE_BOUND,
  };

  let planned: PlannedTransaction;
  let extra: { expiry?: number; expiryIso?: string } = {};
  if (inputs.revoke) {
    if (current.value === 0n) {
      return err({
        category: "CONFLICT",
        code: "DELEGATE_NOT_SET",
        message: `${key.address} is not registered as a metering delegate of ${agent.value}, or was already revoked, so there is nothing to revoke`,
        retryable: false,
      });
    }
    planned = {
      chainId: settings.chainId,
      to: at.value,
      data: encodeRevokeDelegate(key.address),
      summary: `Revoke metering delegate ${key.address}`,
      details: { delegate: key.address },
    };
  } else {
    const expiry = nowSeconds + BigInt(days.value) * 86_400n;
    if (expiry > UINT64_MAX) {
      return validationError("EXPIRY_OUT_OF_RANGE", "the expiry does not fit a uint64", { details: { days: days.value } });
    }
    const expiryIso = isoOf(expiry);
    extra = { expiry: Number(expiry), expiryIso };
    planned = {
      chainId: settings.chainId,
      to: at.value,
      data: encodeSetDelegate(key.address, expiry),
      summary: `Let ${key.address} sign metering claims for this wallet until ${expiryIso}; it cannot move funds`,
      details: { delegate: key.address, expiry: expiryIso },
    };
  }

  const view = { to: planned.to, data: planned.data, summary: planned.summary };
  const action = inputs.revoke ? ("revoke" as const) : ("register" as const);
  if (!inputs.broadcast) {
    return ok({
      ...base,
      ...extra,
      action,
      broadcast: false,
      transaction: view,
      note: inputs.revoke
        ? "Dry run. Nothing was submitted. Add --broadcast to hand this revocation to the wallet; it moves no funds and costs gas in MON."
        : `Dry run. Nothing was submitted${key.created ? `; a new delegate key was written to ${key.path}` : ""}. Add --broadcast to hand this registration to the wallet; it moves no funds and costs gas in MON.`,
    });
  }

  const submitter = await deps.host.submitter();
  if (!submitter.ok) return submitter;
  const sent = await submitter.value.submit(planned);
  if (!sent.ok) return sent;

  return ok({
    ...base,
    ...extra,
    action,
    broadcast: true,
    transaction: view,
    tx: { txHash: sent.value.txHash, status: sent.value.status, explorerUrl: explorerTxUrl(settings, sent.value.txHash) },
    note: inputs.revoke
      ? "Revoked through the wallet. The delegate's signatures stop counting from that block; the key file is kept and can be registered again."
      : "Registered through the wallet. `mm tab call` now signs each metered call with this delegate until the expiry.",
  });
}

/** Why `mm tab call` did or did not sign with a delegate, for the refusal that needs one. */
export type CallDelegateState =
  | { readonly kind: "signing"; readonly key: DelegateKey }
  | { readonly kind: "unsupported" | "no-key" | "not-registered" | "unreadable"; readonly reason: string };

/**
 * The delegate `mm tab call` signs with, when there is one the chain counts.
 *
 * Never a failure: a call is sent unsigned whenever no registered delegate is
 * available, exactly as it was before delegates existed, and the reason is
 * kept for the refusal of a Service that requires a signature.
 */
export async function delegateForCall(deps: { readonly host: Host; readonly settings: PluginSettings; readonly store?: DelegateKeyStore | undefined }, agent: Address): Promise<CallDelegateState> {
  const settings = deps.settings;
  const network = networkName(settings.chainId);
  if (settings.meteringDelegates === undefined) {
    return { kind: "unsupported", reason: `no MeteringDelegates contract is known on ${network}, so this wallet has no way to sign a metered call here` };
  }
  const store = deps.store ?? createDelegateKeyStore();
  const stored = store.load(settings.chainId, agent);
  if (!stored.ok) return { kind: "unreadable", reason: stored.error.message };
  if (stored.value === undefined) {
    return { kind: "no-key", reason: `this wallet has no metering delegate on ${network}; register one with \`mm tab delegate --broadcast\`` };
  }
  const key = stored.value;
  const live = await readIsDelegate(deps.host, settings, settings.meteringDelegates, agent, key.address);
  if (!live.ok) return { kind: "unreadable", reason: `whether ${key.address} is registered could not be read: ${live.error.message}` };
  if (!live.value) {
    return {
      kind: "not-registered",
      reason: `the delegate key ${key.address} is not registered for this wallet on ${network} (never broadcast, lapsed, or revoked); register it with \`mm tab delegate --broadcast\``,
    };
  }
  return { kind: "signing", key };
}
