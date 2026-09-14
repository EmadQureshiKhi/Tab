/**
 * `mm tab authorise`: cap what a Service may meter to this wallet's tab.
 *
 * `TabBook.authorise(serviceId, asset, maxCumulative, expiry)` is the Agent's
 * side of the credit relationship. `recordDelivery` refuses a delivery the Agent
 * never authorised, and refuses one that would push the Service past the
 * cumulative ceiling or past the expiry. It moves no funds, so the wallet's
 * spending policy is not what gates it; it is still a transaction the wallet
 * signs, so it goes through the same executor and is a dry run by default for
 * the same reason `settle` is.
 *
 * The expiry is computed from the clock of the machine running the command,
 * as a day count from now. The contract compares it against `block.timestamp`
 * and refuses one already in the past, so a clock that is minutes out cannot
 * produce a wrong authorisation, only a refused one.
 */

import type { Address, Bytes32, Result } from "@tabai/sdk";
import { ok } from "@tabai/sdk";
import { formatAsset, validationError } from "@tabai/sdk";

import { encodeAuthorise, parseBaseUnits, parseServiceId, UINT64_MAX } from "../calldata.js";
import type { Host, PlannedTransaction } from "../host-context.js";
import { explorerTxUrl, type PluginSettings } from "../settings.js";
import { parseAssetInput, type PlannedTransactionView, type SubmittedView } from "./settle.js";

export interface AuthoriseInputs {
  readonly service: string;
  readonly asset: string;
  /** The cumulative ceiling, in base units. */
  readonly ceiling: string;
  /** Whole days from now until the authorisation lapses. */
  readonly expiryDays: string;
  readonly broadcast: boolean;
}

export interface AuthoriseDeps {
  readonly host: Host;
  readonly settings: PluginSettings;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Milliseconds since the epoch. Defaults to the machine clock. */
  readonly now?: (() => number) | undefined;
}

export interface AuthoriseReport {
  readonly chainId: number;
  readonly broadcast: boolean;
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly asset: string;
  readonly maxCumulativeBaseUnits: string;
  readonly expiry: number;
  readonly expiryIso: string;
  readonly transaction: PlannedTransactionView;
  readonly tx?: SubmittedView;
  readonly note: string;
}

/** Days from a CLI string: a positive whole number small enough that the expiry fits `uint64`. */
export function parseExpiryDays(raw: string): Result<number> {
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text) || Number(text) === 0) {
    return validationError("EXPIRY_DAYS_MALFORMED", `expiryDays must be a whole number of days greater than zero, received \`${raw}\``, {
      details: { value: raw },
    });
  }
  const days = Number(text);
  if (days > 36_500) {
    return validationError("EXPIRY_DAYS_TOO_FAR", "expiryDays must be at most 36500 (a century)", { details: { value: raw } });
  }
  return ok(days);
}

const shortId = (word: string): string => `${word.slice(0, 10)}…${word.slice(-4)}`;

export async function runAuthorise(deps: AuthoriseDeps, inputs: AuthoriseInputs): Promise<Result<AuthoriseReport>> {
  const env = deps.env ?? process.env;
  const settings = deps.settings;
  const now = deps.now ?? (() => Date.now());

  const serviceId = parseServiceId(inputs.service);
  if (!serviceId.ok) return serviceId;
  const asset = parseAssetInput(inputs.asset, settings, env);
  if (!asset.ok) return asset;
  const ceiling = parseBaseUnits(inputs.ceiling, "ceiling");
  if (!ceiling.ok) return ceiling;
  const days = parseExpiryDays(inputs.expiryDays);
  if (!days.ok) return days;

  const expiry = BigInt(Math.floor(now() / 1000)) + BigInt(days.value) * 86_400n;
  if (expiry > UINT64_MAX) {
    return validationError("EXPIRY_OUT_OF_RANGE", "the expiry does not fit a uint64", { details: { expiryDays: days.value } });
  }

  const agent = deps.host.wallet().address();
  if (!agent.ok) return agent;

  const assetName = formatAsset(asset.value.chainId, asset.value.address);
  const expiryIso = new Date(Number(expiry) * 1000).toISOString();
  const planned: PlannedTransaction = {
    chainId: settings.chainId,
    to: settings.tabBook,
    data: encodeAuthorise(serviceId.value, asset.value.address, ceiling.value, expiry),
    summary: `Authorise Service ${shortId(serviceId.value)} to meter up to ${ceiling.value.toString(10)} ${asset.value.symbol} base units until ${expiryIso}`,
    details: {
      serviceId: serviceId.value,
      asset: assetName,
      maxCumulativeBaseUnits: ceiling.value.toString(10),
      expiry: expiryIso,
    },
  };
  const base = {
    chainId: settings.chainId,
    agent: agent.value,
    serviceId: serviceId.value,
    asset: assetName,
    maxCumulativeBaseUnits: ceiling.value.toString(10),
    expiry: Number(expiry),
    expiryIso,
    transaction: { to: planned.to, data: planned.data, summary: planned.summary },
  };

  if (!inputs.broadcast) {
    return ok({
      ...base,
      broadcast: false,
      note: "Dry run. Nothing was submitted. Add --broadcast to hand this transaction to the wallet; it moves no funds and costs gas in MON.",
    });
  }

  const submitter = await deps.host.submitter();
  if (!submitter.ok) return submitter;
  const sent = await submitter.value.submit(planned);
  if (!sent.ok) return sent;

  return ok({
    ...base,
    broadcast: true,
    tx: { txHash: sent.value.txHash, status: sent.value.status, explorerUrl: explorerTxUrl(settings, sent.value.txHash) },
    note: "Broadcast through the wallet. The Service may meter this wallet's tab up to the ceiling until the expiry.",
  });
}
