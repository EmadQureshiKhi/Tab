/**
 * `mm tab call`: call a priced tool on a Service and be metered for it.
 *
 * The result comes back at once and the charge lands on this wallet's Open
 * Tab, to be settled later with `mm tab settle`. Nothing is signed here. The
 * arguments flag is `--args`, not `--json`: `--json` is the host's own output
 * flag and is inherited by every command.
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
import type { TabCallOutput } from "@tabai/sdk";

import { hostFor, settingsOrThrow, unwrap } from "../../boundary.js";
import { runCall } from "../../tab/reads.js";

const inputs = {
  service: {
    type: InputFieldType.Text,
    flag: "service",
    message: "The Service's 32-byte identifier, from `mm tab discover`",
    required: true,
    prompt: false,
    index: 0,
  },
  tool: {
    type: InputFieldType.Text,
    flag: "tool",
    message: "The tool name as the Service prices it, for example quote.generate",
    required: true,
    prompt: false,
    index: 1,
  },
  args: {
    type: InputFieldType.Text,
    flag: "args",
    message: "The tool's arguments as a JSON object literal",
    required: false,
    prompt: false,
  },
  "timeout-ms": {
    type: InputFieldType.Text,
    flag: "timeout-ms",
    message: "How long to wait for the Service (1000 to 120000)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

export default class TabCall extends PluginCommand<TabCallOutput> {
  static override description = "Call a metered tool on a Service. The result is returned now and the charge lands on this wallet's Open Tab, to be settled later. Nothing is signed.";

  static override examples = [
    "<%= config.bin %> tab call 0x7461622e64656d6f000000000000000000000000000000000000000000000000 quote.generate",
    "<%= config.bin %> tab call <serviceId> quote.generate --args '{\"prompt\":\"hello\"}' --json",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags: Interfaces.FlagInput = schemaToFlags(inputs);
  static override args: Interfaces.ArgInput = schemaToArgs(inputs);

  protected readonly pluginCommandId = "tab:call";

  async execute(io: CommandIO): Promise<TabCallOutput> {
    const resolved = await io.resolveInputs(inputs);
    const settings = settingsOrThrow();
    const host = hostFor(this.ctx, io, this.pluginCommandId, settings);
    return unwrap(
      await runCall(
        { settings, host },
        {
          service: resolved.service,
          tool: resolved.tool,
          ...(resolved.args ? { args: resolved.args } : {}),
          ...(resolved["timeout-ms"] ? { timeoutMs: resolved["timeout-ms"] } : {}),
        },
      ),
    );
  }

  override successHint(data: TabCallOutput): string {
    if (data.charge === undefined) return "Delivered. The Service reported no charge.";
    return `Delivered and metered: ${data.charge.amountBaseUnits} base units of ${data.charge.asset} on the Open Tab${
      data.tab === undefined ? "" : `, ${data.tab.headroomBaseUnits} of headroom left`
    }.`;
  }
}
