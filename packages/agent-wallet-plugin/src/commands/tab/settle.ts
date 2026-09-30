/**
 * `mm tab settle`: pay down this wallet's Open Tab with a Service.
 *
 * A dry run unless `--broadcast` is given. The dry run prints the exact
 * transactions the wallet would be handed, the ERC-20 approval when the
 * allowance falls short and `TabSettlement.settle`, with their calldata. With
 * `--broadcast`, both go through the wallet's executor, which is where MetaMask
 * policy decides.
 */

import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import type { Interfaces } from "@oclif/core";

import { hostFor, settingsOrThrow, unwrap } from "../../boundary.js";
import { runSettle, type SettleReport } from "../../tab/settle.js";

const inputs = {
  service: {
    type: InputFieldType.Text,
    flag: "service",
    message: "The Service's 32-byte identifier, from `mm tab discover`",
    required: true,
    prompt: false,
    index: 0,
  },
  asset: {
    type: InputFieldType.Text,
    flag: "asset",
    message: "The Asset to settle in: chainId:0xaddress, or an address on the configured chain",
    required: true,
    prompt: false,
    index: 1,
  },
  amount: {
    type: InputFieldType.Text,
    flag: "amount",
    message: "Base units to settle. USDC has six decimals, so 47000 is 0.047 USDC",
    required: true,
    prompt: false,
    index: 2,
  },
  broadcast: {
    type: InputFieldType.Boolean,
    flag: "broadcast",
    message: "Hand the transactions to the wallet. Without this, print them and stop",
    default: false,
    prompt: false,
  },
} satisfies InputSchema;

export default class TabSettle extends PluginCommand<SettleReport> {
  static override description = "Pay down this wallet's Open Tab with a Service. Builds the approval and TabSettlement.settle, prints both, and submits them through the wallet only with --broadcast.";

  static override examples = [
    "<%= config.bin %> tab settle <serviceId> 10143:0x480209747417f5c830fda188a9b9acfa70bc4083 47000",
    "<%= config.bin %> tab settle <serviceId> 0x480209747417f5c830fda188a9b9acfa70bc4083 47000 --broadcast --json",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags: Interfaces.FlagInput = schemaToFlags(inputs);
  static override args: Interfaces.ArgInput = schemaToArgs(inputs);

  protected readonly pluginCommandId = "tab:settle";

  async execute(io: CommandIO): Promise<SettleReport> {
    const resolved = await io.resolveInputs(inputs);
    const settings = settingsOrThrow();
    const host = hostFor(this.ctx, io, this.pluginCommandId, settings);
    return unwrap(
      await runSettle(
        { host, settings },
        { service: resolved.service, asset: resolved.asset, amount: resolved.amount, broadcast: resolved.broadcast === true },
      ),
    );
  }

  override successHint(data: SettleReport): string {
    if (!data.broadcast) return data.note;
    return `Settled. ${data.settlementTx?.explorerUrl ?? ""}`.trim();
  }

  override analyticsOutcome(data: SettleReport) {
    return data.broadcast ? { tx_hash: data.settlementTx?.txHash } : { outcome: "dry-run" };
  }
}
