/**
 * The SDK toolset, built with the wallet's address as the Agent.
 *
 * Three of the six commands are the SDK's own tools behind a different front
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
  METERING_HEADER,
  createTabToolset,
  resolveTabMcpSettings,
  stderrLogger,
  type RegistryFetch,
  type ServiceHeaderProvider,
  type TabServiceEntry,
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
  /**
   * Signs each metered call, on every Service entry that does not already
   * sign. `mm tab call` passes the registered metering delegate's here.
   */
  readonly meteringHeaders?: ServiceHeaderProvider | undefined;
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
  const signing = options.meteringHeaders;
  const settings: TabMcpSettings =
    signing === undefined
      ? mcp
      : { ...mcp, services: mcp.services.map((entry) => ({ ...entry, headers: withMeteringSignature(entry.headers, signing) })) };
  const toolset = createTabToolset({
    settings,
    env,
    logger: stderrLogger,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.registryFetch === undefined ? {} : { registryFetch: options.registryFetch }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return { toolset, mcp: settings };
}

/** The headers that already carry a metering signature, lower-cased. */
const SIGNED_BY = new Set([METERING_HEADER.operatorSignature, METERING_HEADER.agentSignature].map((name) => name.toLowerCase()));

/**
 * A Service's own headers, then the metering signature when they carry none.
 *
 * A `tab.config` entry or the SDK's hosted default may already sign as the
 * Agent (with `AGENT_PRIVATE_KEY`), and that signature is the stronger claim,
 * so it is kept and nothing is added over it.
 */
export function withMeteringSignature(
  declared: TabServiceEntry["headers"],
  signing: ServiceHeaderProvider,
): ServiceHeaderProvider {
  return async (request) => {
    const base = declared === undefined ? {} : typeof declared === "function" ? await declared(request) : declared;
    if (Object.keys(base).some((name) => SIGNED_BY.has(name.toLowerCase()))) return base;
    return { ...base, ...(await signing(request)) };
  };
}
