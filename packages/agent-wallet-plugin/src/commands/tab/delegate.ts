/**
 * `mm tab delegate`: register a local session key in `MeteringDelegates` so
 * `mm tab call` can sign its metering claims, or revoke it. A dry run unless
 * `--broadcast` is given.
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
import { runDelegate, type DelegateReport } from "../../tab/delegate.js";

const inputs = {
  days: {
    type: InputFieldType.Text,
    flag: "days",
    message: "Whole days from now until the delegate lapses, 1 to 365 (default 30)",
    required: false,
    prompt: false,
  },
  revoke: {
    type: InputFieldType.Boolean,
    flag: "revoke",
    message: "Withdraw the stored delegate instead of registering it",
    default: false,
    prompt: false,
  },
  broadcast: {
    type: InputFieldType.Boolean,
    flag: "broadcast",
    message: "Hand the transaction to the wallet. Without this, print it and stop",
    default: false,
    prompt: false,
  },
} satisfies InputSchema;

export default class TabDelegate extends PluginCommand<DelegateReport> {
  static override description =
    "Register a local session key that signs this wallet's metered calls, so `mm tab call` works against a Service that requires a signature. The key signs metering claims only: it cannot move funds, and charges stay within this wallet's authorisation ceilings. Submits through the wallet only with --broadcast.";

  static override examples = [
    "<%= config.bin %> tab delegate",
    "<%= config.bin %> tab delegate --days 7 --broadcast",
    "<%= config.bin %> tab delegate --revoke --broadcast",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags: Interfaces.FlagInput = schemaToFlags(inputs);
  static override args: Interfaces.ArgInput = schemaToArgs(inputs);

  protected readonly pluginCommandId = "tab:delegate";

  async execute(io: CommandIO): Promise<DelegateReport> {
    const resolved = await io.resolveInputs(inputs);
    const settings = settingsOrThrow();
    const host = hostFor(this.ctx, io, this.pluginCommandId, settings);
    return unwrap(
      await runDelegate(
        { host, settings },
        {
          ...(resolved.days ? { days: resolved.days } : {}),
          revoke: resolved.revoke === true,
          broadcast: resolved.broadcast === true,
        },
      ),
    );
  }

  override successHint(data: DelegateReport): string {
    if (!data.broadcast) return data.note;
    return data.action === "revoke"
      ? `Revoked ${data.delegate}. ${data.tx?.explorerUrl ?? ""}`.trim()
      : `Delegate ${data.delegate} registered until ${data.expiryIso ?? "?"}. ${data.tx?.explorerUrl ?? ""}`.trim();
  }

  override analyticsOutcome(data: DelegateReport) {
    return data.broadcast ? { tx_hash: data.tx?.txHash } : { outcome: "dry-run" };
  }
}
