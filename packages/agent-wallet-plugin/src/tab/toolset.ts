/**
 * The SDK toolset, built with the wallet's address as the Agent.
 *
 * Three of the five commands are the SDK's own tools behind a different front
 * door: `discover`, `status` and `call` are `tab_discover`, `tab_status` and
 * `tab_call` with the Agent filled in from the wallet rather than from
 * `tab.config`. The SDK still loads `tab.config` for the rest, because that is
 * where a Service's endpoint lives and the chain records none.
 *
 * ## stdout belongs to the host
 *
 * `mm` renders a command's return value, and with `--json` that render is the
 * whole of stdout. So the SDK's logger is pointed at stderr here, exactly as the
 * SDK's own MCP server does when it owns stdout.
 */

import type { Address } from "@tabai/sdk";
import {
  createTabToolset,
  resolveTabMcpSettings,
  stderrLogger,
  type RegistryFetch,
  type Tab402Fetch,
  type Tab402Response,
  type TabMcpSettings,
  type TabToolset,
} from "@tabai/sdk";

import type { PluginSettings } from "../settings.js";

export interface BuildToolsetOptions {
  readonly settings: PluginSettings;
  /** The wallet's address, when the command has one. `discover` needs none. */
  readonly agent?: Address | undefined;
  /** Where `tab.config` is looked for. Defaults to the working directory. */
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Test seams, passed straight through to the SDK. */
  readonly registryFetch?: RegistryFetch | undefined;
  readonly fetchImpl?: Tab402Fetch<Tab402Response> | undefined;
}

export interface BuiltToolset {
  readonly toolset: TabToolset;
  readonly mcp: TabMcpSettings;
}

export async function buildToolset(options: BuildToolsetOptions): Promise<BuiltToolset> {
  // The SDK names the Testnet test token only when MOCK_USDC_ADDRESS says where
  // it is, so the resolved address (the environment's, or the recorded one) is
  // handed over explicitly rather than left to whether the caller exported it.
  const baseEnv = options.env ?? process.env;
  const env =
    options.settings.mockUsdc === undefined ? baseEnv : { ...baseEnv, MOCK_USDC_ADDRESS: options.settings.mockUsdc };
  const mcp = await resolveTabMcpSettings({
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    chainId: options.settings.chainId,
    ...(options.settings.registryUrl === undefined ? {} : { registryUrl: options.settings.registryUrl }),
    ...(options.settings.rpcUrl === undefined ? {} : { rpcUrl: options.settings.rpcUrl }),
    explorerUrl: options.settings.explorerUrl,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env,
    logger: stderrLogger,
  });
  const toolset = createTabToolset({
    settings: mcp,
    env,
    logger: stderrLogger,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.registryFetch === undefined ? {} : { registryFetch: options.registryFetch }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return { toolset, mcp };
}
