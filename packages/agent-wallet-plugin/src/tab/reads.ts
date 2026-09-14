/**
 * The three commands that spend nothing: `discover`, `status` and `call`.
 *
 * Each one is an SDK tool with the wallet's address supplied as the Agent.
 * `discover` needs no address at all and asks the host for none, which is why
 * its manifest entry declares no capability: a plugin that asked for
 * `wallet-read` to list Services would be asking for more than it uses.
 *
 * The SDK answers every tool call with a schema-valid payload that carries an
 * `error` block on failure instead of throwing. That block is lifted into a
 * `Result` here so the command boundary can treat every failure the same way.
 */

import type { Address, Result, TabError } from "@tabai/sdk";
import { err, ok } from "@tabai/sdk";
import { validationError, type TabCallOutput, type TabDiscoverOutput, type TabStatusOutput, type TabToolError } from "@tabai/sdk";

import type { Host } from "../host-context.js";
import type { PluginSettings } from "../settings.js";
import { buildToolset, type BuildToolsetOptions } from "./toolset.js";

export interface ReadDeps {
  readonly settings: PluginSettings;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string | undefined;
  readonly registryFetch?: BuildToolsetOptions["registryFetch"];
  readonly fetchImpl?: BuildToolsetOptions["fetchImpl"];
}

export interface DiscoverInputs {
  readonly asset?: string | undefined;
  readonly tier?: string | undefined;
  readonly search?: string | undefined;
  readonly limit?: string | undefined;
}

export interface StatusInputs {
  readonly asset?: string | undefined;
  readonly historyLimit?: string | undefined;
}

export interface CallInputs {
  readonly service: string;
  readonly tool: string;
  /** A JSON object literal, the arguments the tool is posted. */
  readonly args?: string | undefined;
  readonly timeoutMs?: string | undefined;
}

/** The SDK's error block as a `TabError`, so the command boundary has one shape to render. */
const liftError = (error: TabToolError): TabError => ({
  category: error.category,
  code: error.code,
  message: error.message,
  retryable: error.retryable,
  ...(error.requiredBaseUnits === undefined && error.headroomBaseUnits === undefined
    ? {}
    : {
        details: {
          ...(error.requiredBaseUnits === undefined ? {} : { requiredBaseUnits: error.requiredBaseUnits }),
          ...(error.headroomBaseUnits === undefined ? {} : { headroomBaseUnits: error.headroomBaseUnits }),
        },
      }),
});

/** A whole number from an optional flag, or the SDK's own default when the flag is absent. */
function integerFlag(raw: string | undefined, name: string): Result<number | undefined> {
  if (raw === undefined) return ok(undefined);
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) {
    return validationError("FLAG_NOT_INTEGER", `--${name} must be a whole number, received \`${raw}\``, { details: { flag: name } });
  }
  return ok(Number(text));
}

/** Filters, then a qualified Asset name: a bare address takes the configured chain. */
const qualifyAsset = (raw: string | undefined, settings: PluginSettings): string | undefined => {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${settings.chainId}:${text}` : text;
};

export async function runDiscover(deps: ReadDeps, inputs: DiscoverInputs): Promise<Result<TabDiscoverOutput>> {
  const limit = integerFlag(inputs.limit, "limit");
  if (!limit.ok) return limit;
  const { toolset } = await buildToolset({ ...deps });
  const asset = qualifyAsset(inputs.asset, deps.settings);
  const output = await toolset.discover({
    ...(asset === undefined ? {} : { asset }),
    ...(inputs.tier === undefined ? {} : { tier: inputs.tier }),
    ...(inputs.search === undefined ? {} : { search: inputs.search }),
    ...(limit.value === undefined ? {} : { limit: limit.value }),
  });
  if (output.error !== undefined) return err(liftError(output.error));
  return ok(output);
}

export async function runStatus(deps: ReadDeps & { readonly host: Host }, inputs: StatusInputs): Promise<Result<TabStatusOutput>> {
  const agent = deps.host.wallet().address();
  if (!agent.ok) return agent;
  const historyLimit = integerFlag(inputs.historyLimit, "history-limit");
  if (!historyLimit.ok) return historyLimit;
  const { toolset } = await buildToolset({ ...deps, agent: agent.value });
  const asset = qualifyAsset(inputs.asset, deps.settings);
  const output = await toolset.status({
    agent: agent.value,
    ...(asset === undefined ? {} : { asset }),
    ...(historyLimit.value === undefined ? {} : { historyLimit: historyLimit.value }),
  });
  if (output.error !== undefined) return err(liftError(output.error));
  return ok(output);
}

/** The `--args` flag as an object. Anything that is not a JSON object is refused by name. */
export function parseCallArguments(raw: string | undefined): Result<Record<string, unknown> | undefined> {
  if (raw === undefined || raw.trim() === "") return ok(undefined);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return validationError("ARGS_NOT_JSON", `--args must be a JSON object, and this did not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return validationError("ARGS_NOT_OBJECT", "--args must be a JSON object literal, for example '{\"prompt\":\"hello\"}'");
  }
  return ok(parsed as Record<string, unknown>);
}

export async function runCall(deps: ReadDeps & { readonly host: Host }, inputs: CallInputs): Promise<Result<TabCallOutput>> {
  const agent: Result<Address> = deps.host.wallet().address();
  if (!agent.ok) return agent;
  const args = parseCallArguments(inputs.args);
  if (!args.ok) return args;
  const timeoutMs = integerFlag(inputs.timeoutMs, "timeout-ms");
  if (!timeoutMs.ok) return timeoutMs;
  const { toolset } = await buildToolset({ ...deps, agent: agent.value });
  const output = await toolset.call({
    serviceId: inputs.service,
    tool: inputs.tool,
    ...(args.value === undefined ? {} : { arguments: args.value }),
    ...(timeoutMs.value === undefined ? {} : { timeoutMs: timeoutMs.value }),
  });
  // `LIMIT_EXCEEDED` travels as an error with `requiredBaseUnits` and
  // `headroomBaseUnits` in its details, so the command can say how much to
  // settle rather than only that the call was declined.
  if (output.error !== undefined) return err(liftError(output.error));
  return ok(output);
}
