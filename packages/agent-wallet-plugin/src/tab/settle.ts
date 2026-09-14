/**
 * `mm tab settle`: pay down an Open Tab with the wallet's own key.
 *
 * ## Plan first, submit second, and the plan is the answer by default
 *
 * A Settlement is two transactions at most: an ERC-20 `approve` for exactly the
 * amount when the allowance falls short, and `TabSettlement.settle`, which moves
 * the Asset to the Service's Collection address and applies the Settlement to
 * the tab in the same transaction. Both are built here in full, calldata
 * included, before anything is asked of the wallet. Without `--broadcast` that
 * plan is the whole result, so an agent reading the output sees exactly what
 * would be signed. With it, the two are handed to the wallet's executor in
 * order, and the executor is where MetaMask policy applies.
 *
 * ## What the wallet decides, and what this does not
 *
 * The plugin never holds a key and never signs. `wallet-submit` hands it an
 * executor that takes a fully built transaction and answers with a hash and a
 * status, after policy, after any MFA step the wallet requires, and after the
 * receipt when `waitForReceipt` is set, which it is here because `settle` cannot
 * be sent before the approval lands. The Asset and the amount are checked here
 * because a revert on chain costs gas and says less than a refusal that names
 * the Service.
 */

import type { Address, Bytes32, Result } from "@tabai/sdk";
import { ok } from "@tabai/sdk";
import {
  asArray,
  asString,
  createRegistryReadClient,
  field,
  formatAsset,
  notFoundError,
  parseAsset,
  path as jsonPath,
  stderrLogger,
  upstreamError,
  validationError,
  type AssetRef,
  type RegistryFetch,
  type RegistryReadClient,
} from "@tabai/sdk";

import { decodeAllowance, encodeAllowance, encodeApprove, encodeSettle, parseBaseUnits, parseServiceId } from "../calldata.js";
import type { Host, PlannedTransaction, SubmittedTransaction } from "../host-context.js";
import { explorerTxUrl, type PluginSettings } from "../settings.js";

export interface SettleInputs {
  readonly service: string;
  /** `chainId:0xaddress`, or a bare address on the configured chain. */
  readonly asset: string;
  /** Base units, as decimal digits. */
  readonly amount: string;
  readonly broadcast: boolean;
}

export interface SettleDeps {
  readonly host: Host;
  readonly settings: PluginSettings;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Test seam for the registry read. */
  readonly registryFetch?: RegistryFetch | undefined;
  /** Overrides the client built from the settings. */
  readonly registry?: RegistryReadClient | undefined;
}

/** One transaction as the result shows it: everything the wallet will be handed. */
export interface PlannedTransactionView {
  readonly to: Address;
  readonly data: string;
  readonly summary: string;
}

export interface SettlePlan {
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly asset: string;
  readonly assetSymbol: string;
  readonly amountBaseUnits: string;
  readonly allowanceBaseUnits: string;
  /** Null when the allowance already covers the amount. */
  readonly approval: PlannedTransactionView | null;
  readonly settlement: PlannedTransactionView;
}

export interface SubmittedView {
  readonly txHash: string;
  readonly status: string;
  readonly explorerUrl: string;
}

export interface SettleReport {
  readonly chainId: number;
  readonly broadcast: boolean;
  readonly plan: SettlePlan;
  /** Present after a broadcast. Null where no approval was needed. */
  readonly approvalTx?: SubmittedView | null;
  readonly settlementTx?: SubmittedView;
  readonly note: string;
}

/** An Asset the CLI named, on the configured chain. A bare address takes the chain from settings. */
export function parseAssetInput(raw: string, settings: PluginSettings, env: NodeJS.ProcessEnv): Result<AssetRef> {
  const text = raw.trim();
  const qualified = /^0x[0-9a-fA-F]{40}$/.test(text) ? `${settings.chainId}:${text}` : text;
  const parsed = parseAsset(qualified, "asset", env);
  if (!parsed.ok) return parsed;
  if (Number(parsed.value.chainId) !== settings.chainId) {
    return validationError(
      "ASSET_CHAIN_MISMATCH",
      `asset ${qualified} is on chain ${parsed.value.chainId.toString(10)} and this plugin is configured for chain ${settings.chainId} (MONAD_CHAIN_ID)`,
      { details: { asset: qualified, configured: settings.chainId } },
    );
  }
  return ok(parsed.value);
}

/** The registry read client, or the one failure that stands in for it. */
export function registryFor(deps: SettleDeps): Result<RegistryReadClient> {
  if (deps.registry !== undefined) return ok(deps.registry);
  if (deps.settings.registryUrl === undefined) {
    return upstreamError(
      "REGISTRY_UNCONFIGURED",
      "no Tab registry read API is configured, so the Service cannot be checked; set NEXT_PUBLIC_REGISTRY_API_URL",
    );
  }
  return ok(
    createRegistryReadClient({
      baseUrl: deps.settings.registryUrl,
      ...(deps.registryFetch === undefined ? {} : { fetchImpl: deps.registryFetch }),
      logger: stderrLogger,
    }),
  );
}

/** Refuses a Settlement the Service would refuse: an Asset it never accepted. */
export async function serviceAcceptsAsset(
  registry: RegistryReadClient,
  serviceId: Bytes32,
  asset: AssetRef,
): Promise<Result<void>> {
  const body = await registry.service(serviceId);
  if (!body.ok) return body;
  const wanted = asset.address.toLowerCase();
  for (const accepted of asArray(jsonPath(body.value, "service", "acceptedAssets"))) {
    if (asString(field(accepted, "asset"), "").toLowerCase() === wanted) return ok(undefined);
  }
  return notFoundError(
    "ASSET_NOT_ACCEPTED",
    `Service ${serviceId} does not accept ${formatAsset(asset.chainId, asset.address)}, so a Settlement in it would be refused`,
    { details: { serviceId, asset: formatAsset(asset.chainId, asset.address) } },
  );
}

const view = (planned: PlannedTransaction): PlannedTransactionView => ({
  to: planned.to,
  data: planned.data,
  summary: planned.summary,
});

const submittedView = (settings: PluginSettings, sent: SubmittedTransaction): SubmittedView => ({
  txHash: sent.txHash,
  status: sent.status,
  explorerUrl: explorerTxUrl(settings, sent.txHash),
});

const shortId = (word: string): string => `${word.slice(0, 10)}…${word.slice(-4)}`;

/** Builds the plan, and submits it only when asked to. */
export async function runSettle(deps: SettleDeps, inputs: SettleInputs): Promise<Result<SettleReport>> {
  const env = deps.env ?? process.env;
  const settings = deps.settings;

  const serviceId = parseServiceId(inputs.service);
  if (!serviceId.ok) return serviceId;
  const asset = parseAssetInput(inputs.asset, settings, env);
  if (!asset.ok) return asset;
  const amount = parseBaseUnits(inputs.amount, "amount");
  if (!amount.ok) return amount;

  const agent = deps.host.wallet().address();
  if (!agent.ok) return agent;

  const registry = registryFor(deps);
  if (!registry.ok) return registry;
  const accepted = await serviceAcceptsAsset(registry.value, serviceId.value, asset.value);
  if (!accepted.ok) return accepted;

  const chain = deps.host.chain(settings.chainId);
  const allowanceData = await chain.call(asset.value.address, encodeAllowance(agent.value, settings.tabSettlement));
  if (!allowanceData.ok) return allowanceData;
  const allowance = decodeAllowance(allowanceData.value);
  if (!allowance.ok) return allowance;

  const assetName = formatAsset(asset.value.chainId, asset.value.address);
  const units = `${amount.value.toString(10)} ${asset.value.symbol} base units`;

  const approval: PlannedTransaction | null =
    allowance.value >= amount.value
      ? null
      : {
          chainId: settings.chainId,
          to: asset.value.address,
          data: encodeApprove(settings.tabSettlement, amount.value),
          summary: `Approve TabSettlement to move ${units} for one Settlement`,
          details: { spender: settings.tabSettlement, asset: assetName, amountBaseUnits: amount.value.toString(10) },
        };
  const settlement: PlannedTransaction = {
    chainId: settings.chainId,
    to: settings.tabSettlement,
    data: encodeSettle(serviceId.value, asset.value.address, amount.value),
    summary: `Settle ${units} of the Open Tab with Service ${shortId(serviceId.value)}`,
    details: { serviceId: serviceId.value, asset: assetName, amountBaseUnits: amount.value.toString(10) },
  };

  const plan: SettlePlan = {
    agent: agent.value,
    serviceId: serviceId.value,
    asset: assetName,
    assetSymbol: asset.value.symbol,
    amountBaseUnits: amount.value.toString(10),
    allowanceBaseUnits: allowance.value.toString(10),
    approval: approval === null ? null : view(approval),
    settlement: view(settlement),
  };

  if (!inputs.broadcast) {
    return ok({
      chainId: settings.chainId,
      broadcast: false,
      plan,
      note: `Dry run. Nothing was submitted. Add --broadcast to hand ${approval === null ? "this transaction" : "these two transactions"} to the wallet; that spends real funds.`,
    });
  }

  const submitter = await deps.host.submitter();
  if (!submitter.ok) return submitter;

  let approvalTx: SubmittedView | null = null;
  if (approval !== null) {
    const sent = await submitter.value.submit(approval);
    if (!sent.ok) return sent;
    approvalTx = submittedView(settings, sent.value);
  }
  const sent = await submitter.value.submit(settlement);
  if (!sent.ok) return sent;

  return ok({
    chainId: settings.chainId,
    broadcast: true,
    plan,
    approvalTx,
    settlementTx: submittedView(settings, sent.value),
    note: "Broadcast through the wallet. The Settlement is final when its block is; headroom is restored in that block.",
  });
}
