/**
 * `mm tab status`: what this wallet owes, may still spend, and has settled,
 * per Asset. The wallet's selected address is the Agent; nothing is signed.
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
import type { TabStatusOutput } from "@tabai/sdk";

import { hostFor, settingsOrThrow, unwrap } from "../../boundary.js";
import { runStatus } from "../../tab/reads.js";

const inputs = {
  asset: {
    type: InputFieldType.Text,
    flag: "asset",
    message: "Only this Asset (chainId:0xaddress, or an address on the configured chain)",
    required: false,
    prompt: false,
  },
  "history-limit": {
    type: InputFieldType.Text,
    flag: "history-limit",
    message: "How many recent Settlements to include (0 to 200)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

export default class TabStatus extends PluginCommand<TabStatusOutput> {
  static override description = "Credit limit, Open Tab, prepaid credit and headroom for this wallet, per Asset, with recent Settlements. A keyless read of the registry.";

  static override examples = [
    "<%= config.bin %> tab status",
    "<%= config.bin %> tab status --asset 10143:0x480209747417f5c830fda188a9b9acfa70bc4083 --json",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags: Interfaces.FlagInput = schemaToFlags(inputs);
  static override args: Interfaces.ArgInput = schemaToArgs(inputs);

  protected readonly pluginCommandId = "tab:status";

  async execute(io: CommandIO): Promise<TabStatusOutput> {
    const resolved = await io.resolveInputs(inputs);
    const settings = settingsOrThrow();
    const host = hostFor(this.ctx, io, this.pluginCommandId, settings);
    return unwrap(
      await runStatus(
        { settings, host },
        {
          ...(resolved.asset ? { asset: resolved.asset } : {}),
          ...(resolved["history-limit"] ? { historyLimit: resolved["history-limit"] } : {}),
        },
      ),
    );
  }

  override successHint(data: TabStatusOutput): string {
    const open = data.perAsset.filter((entry) => entry.openTabBaseUnits !== "0");
    return open.length === 0
      ? `Agent ${data.agent} owes nothing.`
      : `Agent ${data.agent} has ${open.length} open tab${open.length === 1 ? "" : "s"}. Pay one down with: mm tab settle <service> <asset> <amount> --broadcast`;
  }
}
