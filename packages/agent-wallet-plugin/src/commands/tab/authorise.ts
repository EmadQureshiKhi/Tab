/**
 * `mm tab authorise`: cap what a Service may meter to this wallet's tab in one
 * Asset, until an expiry. A dry run unless `--broadcast` is given.
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
import { runAuthorise, type AuthoriseReport } from "../../tab/authorise.js";

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
    message: "The Asset the cap applies to: chainId:0xaddress, or an address on the configured chain",
    required: true,
    prompt: false,
    index: 1,
  },
  ceiling: {
    type: InputFieldType.Text,
    flag: "ceiling",
    message: "The cumulative ceiling the Service may meter, in base units",
    required: true,
    prompt: false,
    index: 2,
  },
  "expiry-days": {
    type: InputFieldType.Text,
    flag: "expiry-days",
    message: "Whole days from now until the authorisation lapses",
    required: true,
    prompt: false,
    index: 3,
  },
  broadcast: {
    type: InputFieldType.Boolean,
    flag: "broadcast",
    message: "Hand the transaction to the wallet. Without this, print it and stop",
    default: false,
  },
} satisfies InputSchema;

export default class TabAuthorise extends PluginCommand<AuthoriseReport> {
  static override description = "Authorise a Service to meter this wallet's tab in one Asset, up to a cumulative ceiling, until an expiry. Moves no funds. Submits through the wallet only with --broadcast.";

  static override examples = [
    "<%= config.bin %> tab authorise <serviceId> 10143:0x480209747417f5c830fda188a9b9acfa70bc4083 5000000 30",
    "<%= config.bin %> tab authorise <serviceId> 0x480209747417f5c830fda188a9b9acfa70bc4083 5000000 30 --broadcast",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags: Interfaces.FlagInput = schemaToFlags(inputs);
  static override args: Interfaces.ArgInput = schemaToArgs(inputs);

  protected readonly pluginCommandId = "tab:authorise";

  async execute(io: CommandIO): Promise<AuthoriseReport> {
    const resolved = await io.resolveInputs(inputs);
    const settings = settingsOrThrow();
    const host = hostFor(this.ctx, io, this.pluginCommandId, settings);
    return unwrap(
      await runAuthorise(
        { host, settings },
        {
          service: resolved.service,
          asset: resolved.asset,
          ceiling: resolved.ceiling,
          expiryDays: resolved["expiry-days"],
          broadcast: resolved.broadcast === true,
        },
      ),
    );
  }

  override successHint(data: AuthoriseReport): string {
    return data.broadcast ? `Authorised until ${data.expiryIso}. ${data.tx?.explorerUrl ?? ""}`.trim() : data.note;
  }

  override analyticsOutcome(data: AuthoriseReport) {
    return data.broadcast ? { tx_hash: data.tx?.txHash } : { outcome: "dry-run" };
  }
}
