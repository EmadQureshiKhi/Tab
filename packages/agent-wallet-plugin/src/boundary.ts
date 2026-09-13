/**
 * The command boundary: where a `Result` becomes what the host expects.
 *
 * Everything under `src/tab/` answers with a `Result` and throws nothing. The
 * host's contract for a failed command is a thrown `CommandError` carrying a
 * code, a message and a hint, rendered by the host and turned into a non-zero
 * exit. So the five command classes are the one place in this package where a
 * `Result` error is re-raised, exactly as the SDK's Hono adapter re-raises at
 * its own framework boundary. Nothing else in the package does.
 *
 * This file lives outside `src/commands/` because oclif treats every module in
 * that tree as a command.
 */

import { CommandError } from "@metamask/agent-wallet/plugin";
import type { CommandIO } from "@metamask/agent-wallet/plugin";
import type { Result, TabError } from "@tabai/sdk";

import { createHost, type Host, type HostContext } from "./host-context.js";
import { processPluginEnv, resolvePluginSettings, type PluginSettings } from "./settings.js";

/** A hint the host can print under the error. Specific where the remedy is known. */
export function hintFor(error: TabError): string {
  const details = error.details ?? {};
  switch (error.code) {
    case "LIMIT_EXCEEDED": {
      const required = details["requiredBaseUnits"];
      const headroom = details["headroomBaseUnits"];
      return `The call needs ${String(required ?? "?")} base units and the tab has ${String(headroom ?? "?")} of headroom. Settle with \`mm tab settle <service> <asset> <amount> --broadcast\` and call again; retrying without settling repeats the refusal.`;
    }
    case "REGISTRY_UNCONFIGURED":
      return "Set NEXT_PUBLIC_REGISTRY_API_URL to the Tab registry read API, or registryUrl in tab.config.";
    case "SERVICE_ENDPOINT_UNKNOWN":
      return "The chain records no URL for a Service. Add its endpoint to the `services` list in a tab.config file in this directory or a parent.";
    case "WALLET_MISSING":
      return "Run `mm init` to set a wallet up, or `mm wallet select` to choose an EVM wallet.";
    case "CAPABILITY_MISSING":
      return "Reinstall the plugin and accept the listed capabilities, or run `mm plugins install <plugin> --accept-permissions`.";
    case "ASSET_NOT_ACCEPTED":
      return "Run `mm tab discover` to see which Assets the Service accepts.";
    case "AGENT_UNCONFIGURED":
      return "This command takes the Agent from the wallet; make sure a wallet is selected.";
    default:
      return error.retryable
        ? "This looked transient. Try again, and check MONAD_RPC_URL and NEXT_PUBLIC_REGISTRY_API_URL if it persists."
        : "Run `mm tab --help` for the command surface, or `mm tab discover` to list Services.";
  }
}

/** Unwraps a `Result`, re-raising a failure as the host's `CommandError`. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const error = result.error;
  const suffix = error.cause === undefined ? "" : ` (${error.cause.message})`;
  throw new CommandError(error.code, `${error.message}${suffix}`, hintFor(error));
}

/** The plugin settings from the process environment, or a `CommandError` naming the variable. */
export function settingsOrThrow(): PluginSettings {
  return unwrap(resolvePluginSettings(processPluginEnv()));
}

/** The host bridge for one command run. */
export function hostFor(ctx: unknown, io: CommandIO, commandId: string, settings: PluginSettings): Host {
  return createHost({
    ctx: (ctx ?? {}) as HostContext,
    io,
    commandId,
    rpcUrl: settings.rpcUrl,
  });
}
